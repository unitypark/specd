import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  BUILDABLE_STATUSES,
  citationDrift,
  isModelId,
  slugify,
  specBranchName,
  type CitationDrift,
  type ModelId,
  type SpecView,
} from '@specd/shared';
import { SpecNotApproved } from '../common/errors.js';
import { ProjectsService } from '../projects/projects.service.js';
import { RepositoriesService } from '../projects/repositories.service.js';
import { ConnectionsService } from '../projects/connections.service.js';
import { KnowledgeService } from '../knowledge/knowledge.service.js';
import { PolicyService } from '../projects/policy.service.js';
import { SpecsService } from '../specs/specs.service.js';
import { BoardService } from '../board/board.service.js';
import { RunsService } from '../runs/runs.service.js';
import { RunnersService } from '../runners/runners.service.js';
import type {
  BuildJobPayload,
  OnboardJobPayload,
  SpecJobPayload,
} from '../runners/runner-jobs.service.js';
import { OnboardingAgent } from './onboarding.agent.js';
import { SpecAgent } from './spec.agent.js';
import { BuildAgent } from './build.agent.js';
import { IndexQueueService } from './index-queue.service.js';
import { OnboardQueueService } from './onboard-queue.service.js';

/** What queueing a station-02 run tells the caller. The outcome arrives on the
 *  run itself — there is no branch or PR to report yet (0016). */
export interface OnboardEnqueued {
  repositoryId: string;
  repoName: string;
  runId: string;
  queued: true;
  /** Set when this request joined a run that was already in flight. */
  coalescedInto?: string;
}

/**
 * Orchestration. Each public method here is one station of the fixed pipeline
 * (D11) and shares the same shape:
 *
 *   check the gate/cap → open an auditable run → do the work → meter → finish
 *
 * Spec and build runs are executed in-process and awaited: a spec draft is a
 * single model call, and pretending it is a distributed job would add a
 * scheduler with nothing to schedule. Index runs ([[0012]]) and onboard runs
 * ([[0016]]) are the exceptions — both are long enough that holding a request
 * open for them is the wrong shape, so each is an `agent_runs` row that a
 * worker in this process claims. None of that is a queue *system*: Postgres
 * remains the only store, which is what knowledge/decisions/0008 asked for.
 * Dispatch to a self-hosted runner is the same mechanism from the other side —
 * the runner claims a queued row by polling.
 */
@Injectable()
export class PipelineService {
  private readonly logger = new Logger(PipelineService.name);

  constructor(
    private readonly projects: ProjectsService,
    private readonly repositories: RepositoriesService,
    private readonly connections: ConnectionsService,
    private readonly knowledge: KnowledgeService,
    private readonly policy: PolicyService,
    private readonly specs: SpecsService,
    private readonly board: BoardService,
    private readonly runs: RunsService,
    private readonly runners: RunnersService,
    private readonly onboarding: OnboardingAgent,
    private readonly specAgent: SpecAgent,
    private readonly build: BuildAgent,
    private readonly indexQueue: IndexQueueService,
    private readonly onboardQueue: OnboardQueueService,
  ) {}

  /**
   * Station 02 — Ground. Queues one run per repository and returns (0016).
   *
   * Grounding reads a whole repository and then calls a model; holding an HTTP
   * request open for that was already the wrong shape, and while it ran inline
   * nothing stopped a second click from opening a second setup PR. The caller
   * follows the run for the outcome, exactly as re-index has done since 0012.
   */
  async enqueueOnboarding(input: {
    projectId: string;
    repositoryIds: string[];
    actor: { userId: string; name: string };
  }): Promise<OnboardEnqueued[]> {
    // Checked here so a paused project or a spent cap is an answer to *this*
    // request, and again in the worker because either can change while a run
    // waits — a claim is not a standing permission.
    await this.runs.assertCanRun(input.projectId);

    const results: OnboardEnqueued[] = [];
    let queuedAny = false;

    for (const repoId of input.repositoryIds) {
      // Resolved in the request path so an unknown repository is a 404 the
      // caller sees, rather than a queued run that fails out of sight.
      const repo = await this.repositories.get(input.projectId, repoId);

      const existing = await this.runs.pendingOnboardRun(input.projectId, repo.id);
      if (existing) {
        await this.runs.logRun(
          existing.id,
          `${input.actor.name} asked to ground ${repo.name} again while this run was ` +
            `still in flight — folded into this run rather than opening a second setup PR`,
        );
        results.push({
          repositoryId: repo.id,
          repoName: repo.name,
          runId: existing.id,
          queued: true,
          coalescedInto: existing.id,
        });
        continue;
      }

      const runId = await this.runs.enqueue({
        projectId: input.projectId,
        kind: 'onboard',
        triggeredByUserId: input.actor.userId,
        triggeredByName: input.actor.name,
        repositoryId: repo.id,
        // Left null deliberately. A runner's claim keys on `job_payload IS NOT
        // NULL` for a dispatchable kind (0004/0005), so filling it before
        // `OnboardingAgent.prepare()` has produced a prompt would let a paired
        // runner claim a job with nothing in it yet.
        jobPayload: null,
      });
      await this.runs.logRun(runId, 'queued — waiting for the onboarding worker');
      results.push({ repositoryId: repo.id, repoName: repo.name, runId, queued: true });
      queuedAny = true;
    }

    if (queuedAny) await this.onboardQueue.wake();
    return results;
  }

  /**
   * Execute a queued onboarding run — the counterpart to `runReindex`, called
   * by the worker that claimed the row and never from a request path.
   */
  async runOnboardingRun(input: {
    runId: string;
    projectId: string;
    repositoryId: string;
  }): Promise<void> {
    const run = this.runs.handleFor(input.runId);

    try {
      await this.runs.assertCanRun(input.projectId);

      const project = await this.projects.byId(input.projectId);
      const repo = await this.repositories.get(input.projectId, input.repositoryId);
      const ai = await this.connections.resolveAi(project.id, project.defaultModel);
      const model = this.resolveModel(ai.model, project.defaultModel);
      // The row was queued before anything knew which model it would use.
      await this.runs.setModel(input.runId, model);

      const pairedRunner =
        ai.mode === 'subscription_runner' ? await this.runners.pickPaired(project.id) : null;

      if (pairedRunner) {
        const prepared = await this.onboarding.prepare({ repo, projectName: project.name, run });
        const payload: OnboardJobPayload = {
          kind: 'onboard',
          system: prepared.system,
          user: prepared.user,
          schema: prepared.schema,
          model,
          maxTokens: 32_000,
          ctx: prepared.ctx,
        };
        // Hands the row on rather than finishing it: `queueForRunner` sets
        // `runner = 'self_hosted'`, which is precisely what stops this worker
        // from claiming it straight back off the queue (0016).
        await this.runs.queueForRunner(input.runId, payload as unknown as Record<string, unknown>);
        await run.log(`queued for runner "${pairedRunner.name}" — waiting for it to poll`);
        return;
      }

      const result = await this.onboarding.run({
        repo,
        projectName: project.name,
        apiKey: ai.apiKey,
        model,
        mode: ai.mode,
        run,
      });
      await this.runs.finish(input.runId, {
        status: 'succeeded',
        result: { branch: result.branch, url: result.url, files: result.fileCount },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await run.log(message, 'error');
      await this.runs.finish(input.runId, { status: 'failed', error: message });
      this.logger.warn(`onboarding run ${input.runId} failed: ${message}`);
      throw err;
    }
  }

  /** Station 03 — Spec. A deliberate human click, never automatic (§8). */
  async generateSpec(input: {
    projectId: string;
    ticketId: string;
    actor: { userId: string; name: string };
    /** Set when re-drafting: v2 consumes the review discussion. */
    reviseFromSpecId?: string;
  }): Promise<{ spec: SpecView | null; runId: string; queued?: boolean }> {
    await this.runs.assertCanRun(input.projectId);

    const project = await this.projects.byId(input.projectId);
    const ticket = await this.board.get(input.projectId, input.ticketId);
    const repos = await this.repositories.list(input.projectId);
    const primary = repos.find((r) => r.isPrimary) ?? repos[0];

    if (!primary) {
      throw new BadRequestException(
        'Connect at least one repository before generating a spec — there is nothing to ground it in.',
      );
    }

    const ai = await this.connections.resolveAi(project.id, project.defaultModel);
    const model = this.resolveModel(ai.model, project.defaultModel);

    let revisionNotes: string[] | undefined;
    let previousContent;
    if (input.reviseFromSpecId) {
      const previous = await this.specs.byId(input.projectId, input.reviseFromSpecId);
      revisionNotes = await this.specs.revisionNotes(previous.id);
      previousContent = previous.content;
    }

    // A paired runner takes priority over local Claude Code when both could
    // serve this request — pairing is an explicit statement of where the
    // customer wants their subscription quota spent, and dogfooding the real
    // dispatch path in dev is more honest than a synchronous shortcut that a
    // hosted deployment (no local `claude` at all) could never take anyway.
    const pairedRunner =
      ai.mode === 'subscription_runner' ? await this.runners.pickPaired(project.id) : null;

    const run = await this.runs.start({
      projectId: input.projectId,
      kind: 'spec',
      model,
      runner: ai.mode === 'subscription_runner' ? 'self_hosted' : 'hosted',
      triggeredByUserId: input.actor.userId,
      triggeredByName: input.actor.name,
      ticketId: ticket.id,
    });

    if (pairedRunner) {
      try {
        const prepared = await this.specAgent.prepare({
          projectId: project.id,
          projectName: project.name,
          ticketKey: ticket.key,
          title: ticket.title,
          body: ticket.body,
          repoNames: repos.map((r) => r.name),
          primaryRepo: primary.name,
          run,
          revisionNotes,
          previousContent,
        });

        const payload: SpecJobPayload = {
          kind: 'spec',
          system: prepared.system,
          user: prepared.user,
          schema: prepared.schema,
          model,
          maxTokens: 32_000,
          effort: 'high',
          chunks: prepared.chunks,
          coverage: prepared.coverage,
          slug: prepared.slug,
          ticketKey: ticket.key,
          ticketId: ticket.id,
          primaryRepo: primary.name,
          projectId: project.id,
        };
        await this.runs.queueForRunner(run.id, payload as unknown as Record<string, unknown>);
        await run.log(`queued for runner "${pairedRunner.name}" — waiting for it to poll`);

        return { spec: null, runId: run.id, queued: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await run.log(message, 'error');
        await this.runs.finish(run.id, { status: 'failed', error: message });
        throw err;
      }
    }

    try {
      const draft = await this.specAgent.draft({
        projectId: project.id,
        projectName: project.name,
        ticketKey: ticket.key,
        title: ticket.title,
        body: ticket.body,
        repoNames: repos.map((r) => r.name),
        primaryRepo: primary.name,
        apiKey: ai.apiKey,
        model,
        mode: ai.mode,
        run,
        revisionNotes,
        previousContent,
      });

      const spec = await this.specs.createVersion({
        projectId: project.id,
        ticketId: ticket.id,
        content: draft.content,
        createdByRunId: run.id,
      });

      await run.log(`spec v${spec.version} published to the board ✓`);
      await this.runs.finish(run.id, {
        status: 'succeeded',
        result: { specId: spec.id, version: spec.version },
      });

      return { spec, runId: run.id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await run.log(message, 'error');
      await this.runs.finish(run.id, { status: 'failed', error: message });
      throw err;
    }
  }

  /**
   * Station 05 — Build (handoff mode (a), the hosted runner).
   *
   * The gate is re-checked here rather than trusted from the caller: a build
   * is the first moment agent output reaches code, so "is this approved?" is
   * asked again at the point of use.
   */
  async runBuild(input: {
    projectId: string;
    specId: string;
    actor: { userId: string; name: string };
    /** A named human taking responsibility for a house rule refusing this. */
    policyOverride?: { justification: string };
  }) {
    await this.runs.assertCanRun(input.projectId);

    const project = await this.projects.byId(input.projectId);
    const spec = await this.specs.byId(input.projectId, input.specId);

    if (!BUILDABLE_STATUSES.includes(spec.status)) {
      // Same refusal the CLI gets. Nothing reaches a coding agent unstamped.
      throw new SpecNotApproved(spec.status);
    }

    const repos = await this.repositories.list(input.projectId);
    const primary = repos.find((r) => r.isPrimary) ?? repos[0];
    if (!primary) throw new BadRequestException('This project has no repository to build in.');

    const ai = await this.connections.resolveAi(project.id, project.defaultModel);
    const model = this.resolveModel(ai.model, project.defaultModel);

    // Ground the build in the same knowledge the spec was drafted against.
    const { chunks } = await this.knowledge.retrieve(
      project.id,
      `${spec.title}\n${spec.content.design.map((d) => d.text).join('\n')}`,
      10,
    );
    const knowledgeExcerpts = chunks
      .map((c) => `[${c.path}${c.heading ? `#${c.heading}` : ''}]\n${c.text.slice(0, 1_500)}`)
      .join('\n\n---\n\n');

    // The gate is re-checked at the point of use; the evidence never was.
    // A spec approved on Monday can build on Friday against a knowledge base
    // that merged on Wednesday, so a claim can arrive here citing a section
    // that has since been rewritten or overtaken by the code it describes.
    //
    // This reuses the retrieval above rather than checking each citation on
    // its own — same chunks, same coverage, same judgement the SpecAgent made
    // at drafting, for the cost of one more query instead of one per claim.
    const drifted = citationDrift(
      spec.content.design,
      chunks,
      {
        ...(await this.knowledge.coverageFor(
          input.projectId,
          chunks.map((c) => c.path),
        )),
        truncatedCount: 0,
      },
    );

    const run = await this.runs.start({
      projectId: input.projectId,
      kind: 'build',
      model,
      runner: ai.mode === 'subscription_runner' ? 'self_hosted' : 'hosted',
      triggeredByUserId: input.actor.userId,
      triggeredByName: input.actor.name,
      ticketId: spec.ticketId,
      repositoryId: primary.id,
    });

    // Only move to `building` once the run is actually under way.
    if (spec.status === 'approved') {
      await this.specs.transition({
        projectId: input.projectId,
        specId: spec.id,
        to: 'building',
        actor: input.actor,
      });
    }

    // House rules, as data (2.4). The gate above is binary and stays that way;
    // this is the floor a team chose on top of it, and unlike the gate it can
    // be overridden — by a named human, with a typed reason, on the record.
    const refusals = await this.policy.refusalsForBuild(input.projectId, spec, drifted);
    if (refusals.length > 0 && !input.policyOverride) this.policy.refuse(refusals);

    // Advisory, deliberately: this reports, it does not refuse. A citation that
    // drifted is a reason for a human to look, and turning it into a block
    // would mean an unrelated doc edit could stop an approved spec from
    // building. Making it refusable is a per-project policy decision (2.4).
    for (const claim of drifted) {
      await run.log(
        `  citation drifted since approval: ${claim.citation} was ${claim.was}, now ${claim.now}` +
          (claim.note ? ` — ${claim.note}` : ''),
        'warn',
      );
    }
    if (drifted.length > 0) {
      await run.log(
        `${drifted.length} of this spec's citations no longer stand where they did at approval`,
        'warn',
      );
    }

    if (refusals.length > 0 && input.policyOverride) {
      // Written before the work starts: an override recorded only on success
      // is missing exactly when someone wants to read it.
      await this.policy.recordException({
        projectId: input.projectId,
        specId: spec.id,
        runId: run.id,
        ticketKey: spec.ticketKey,
        refusals,
        approvedByUserId: input.actor.userId,
        approvedByName: input.actor.name,
        justification: input.policyOverride.justification,
      });
      for (const refusal of refusals) {
        await run.log(
          `policy "${refusal.policy}" overridden by ${input.actor.name}: ${refusal.detail} ` +
            `Reason given: ${input.policyOverride.justification}`,
          'warn',
        );
      }
    }

    // Dispatch to a paired runner when there is one — it builds on its own
    // machine with its own git credentials (D9). A `local` repository has no
    // remote another machine could clone, so it always stays in-process:
    // `prepare()` returns a null remote and we fall through.
    const pairedRunner =
      ai.mode === 'subscription_runner' ? await this.runners.pickPaired(project.id) : null;

    if (pairedRunner) {
      try {
        const prepared = await this.build.prepare({
          repo: primary,
          spec,
          projectName: project.name,
          knowledgeExcerpts,
          model,
          drifted,
        });

        if (prepared.remote) {
          const payload: BuildJobPayload = {
            kind: 'build',
            model,
            system: prepared.system,
            branch: prepared.branch,
            asBuiltPath: prepared.asBuiltPath,
            asBuiltCommitMessage: prepared.asBuiltCommitMessage,
            verifyCommand: prepared.verifyCommand,
            tasks: prepared.tasks,
            remote: prepared.remote,
            ticketKey: spec.ticketKey,
            ctx: { repo: primary, spec },
          };

          await this.runs.queueForRunner(run.id, payload as unknown as Record<string, unknown>);
          await run.log(
            `queued for runner "${pairedRunner.name}" — it clones and pushes ${primary.name} with ` +
              'its own git credentials; specd sends no token',
          );

          return {
            runId: run.id,
            specId: spec.id,
            ticketKey: spec.ticketKey,
            branch: prepared.branch,
            started: true as const,
            queued: true as const,
          };
        }

        await run.log(
          `runner "${pairedRunner.name}" is paired, but ${primary.name} is a local repository ` +
            'with no remote it could clone — building here instead',
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await run.log(message, 'error').catch(() => undefined);
        await this.runs.finish(run.id, { status: 'failed', error: message }).catch(() => undefined);
        throw err;
      }
    }

    // A build runs for minutes, so it is *started* here and watched through
    // the run log. Holding an HTTP request open for the duration would time
    // out under any proxy and gives the caller nothing a stream doesn't.
    void this.executeBuild({
      repo: primary,
      spec,
      projectName: project.name,
      knowledgeExcerpts,
      model,
      drifted,
      run,
    });

    return {
      runId: run.id,
      specId: spec.id,
      ticketKey: spec.ticketKey,
      branch: specBranchName(spec.ticketKey, slugify(spec.title)),
      started: true as const,
    };
  }

  /** The build body. Errors land on the run, never as an unhandled rejection. */
  private async executeBuild(input: {
    repo: Awaited<ReturnType<RepositoriesService['get']>>;
    spec: SpecView;
    drifted: CitationDrift[];
    projectName: string;
    knowledgeExcerpts: string;
    model: ModelId;
    run: Awaited<ReturnType<RunsService['start']>>;
  }): Promise<void> {
    const { run, spec } = input;
    try {
      const result = await this.build.run(input);
      await run.log(
        'merge the branch to complete the loop — the as-built spec re-indexes on merge',
      );
      await this.runs.finish(run.id, { status: 'succeeded', result: { ...result } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await run.log(message, 'error').catch(() => undefined);
      await this.runs
        .finish(run.id, { status: 'failed', error: message })
        .catch(() => undefined);
      this.logger.warn(`build failed for ${spec.ticketKey}: ${message}`);
    }
  }

  /**
   * Station 06 — Learn. Queue a re-index of knowledge/ and return (0012).
   *
   * The caller is usually a webhook handler with a ten-second budget from
   * GitHub, so nothing here does any indexing: it writes one queued row and
   * nudges the worker. Bursts fold together — three merges in a minute should
   * cost one index, not three — so an existing queued run for this project is
   * reused, widened to cover both requests' repositories.
   */
  async enqueueReindex(input: {
    projectId: string;
    repositoryIds?: string[];
    actor: { userId: string; name: string } | null;
    /**
     * Who to credit when there is no signed-in user — "github webhook
     * (merged by alice)" rather than a blanket "scheduler". An automated
     * trigger is not a person, and the run log should not imply one.
     */
    triggeredByName?: string;
  }): Promise<{ runId: string; status: 'queued'; coalescedInto?: string }> {
    const requested = input.repositoryIds ?? [];

    const existing = await this.runs.pendingIndexRun(input.projectId);
    if (existing) {
      await this.runs.widenIndexScope(existing.id, requested);
      await this.runs.logRun(
        existing.id,
        `another re-index was requested${input.triggeredByName ? ` by ${input.triggeredByName}` : ''} ` +
          `before this one started — folded into this run`,
      );
      await this.indexQueue.wake();
      return { runId: existing.id, status: 'queued', coalescedInto: existing.id };
    }

    const runId = await this.runs.enqueue({
      projectId: input.projectId,
      kind: 'index',
      triggeredByUserId: input.actor?.userId ?? null,
      triggeredByName: input.actor?.name ?? input.triggeredByName ?? 'scheduler',
      repositoryId: requested.length === 1 ? requested[0]! : null,
      jobPayload: { repositoryIds: requested },
    });
    await this.runs.logRun(runId, 'queued — waiting for the indexer');
    await this.indexQueue.wake();
    return { runId, status: 'queued' };
  }

  /**
   * Execute a queued index run. Called by the worker that claimed it, never
   * from a request path.
   */
  async runReindex(input: {
    runId: string;
    projectId: string;
    repositoryIds?: string[];
  }) {
    const run = this.runs.handleFor(input.runId);
    const repos = input.repositoryIds?.length
      ? await Promise.all(
          input.repositoryIds.map((id) => this.repositories.get(input.projectId, id)),
        )
      : await this.repositories.list(input.projectId);

    let indexed = 0;
    let skipped = 0;
    let removed = 0;

    try {
      for (const repo of repos) {
        const result = await this.knowledge.indexRepository(repo, (msg) => run.log(msg));
        indexed += result.indexed;
        skipped += result.skipped;
        removed += result.removed;
      }

      const health = await this.knowledge.health(input.projectId);
      await run.log(
        `re-embedded ${indexed} doc(s) · ${skipped} unchanged · ${removed} removed · ` +
          `knowledge health ${Math.round(health.score)}%`,
      );
      await this.runs.finish(run.id, {
        status: 'succeeded',
        result: { indexed, skipped, removed, health: health.score },
      });
      return { indexed, skipped, removed, health: health.score, runId: run.id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await run.log(message, 'error');
      await this.runs.finish(run.id, { status: 'failed', error: message });
      throw err;
    }
  }

  private resolveModel(candidate: string, fallback: string): ModelId {
    if (isModelId(candidate)) return candidate;
    if (isModelId(fallback)) return fallback;
    return 'claude-opus-5';
  }
}
