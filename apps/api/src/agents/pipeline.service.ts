import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  BUILDABLE_STATUSES,
  isModelId,
  slugify,
  specBranchName,
  type ModelId,
  type SpecView,
} from '@specd/shared';
import { SpecNotApproved } from '../common/errors.js';
import { ProjectsService } from '../projects/projects.service.js';
import { RepositoriesService } from '../projects/repositories.service.js';
import { ConnectionsService } from '../projects/connections.service.js';
import { KnowledgeService } from '../knowledge/knowledge.service.js';
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

/**
 * Orchestration. Each public method here is one station of the fixed pipeline
 * (D11) and shares the same shape:
 *
 *   check the gate/cap → open an auditable run → do the work → meter → finish
 *
 * Runs are executed in-process and awaited. That is honest for P1: a spec
 * draft is a single model call, and pretending it is a distributed job would
 * add a queue with nothing to schedule. Dispatch to a self-hosted runner is
 * the one exception, and it is a poll, not a queue — the runner claims a
 * queued `agent_runs` row. A real queue is only warranted once runs execute
 * somewhere other than this process; see knowledge/decisions/0008.
 */
@Injectable()
export class PipelineService {
  private readonly logger = new Logger(PipelineService.name);

  constructor(
    private readonly projects: ProjectsService,
    private readonly repositories: RepositoriesService,
    private readonly connections: ConnectionsService,
    private readonly knowledge: KnowledgeService,
    private readonly specs: SpecsService,
    private readonly board: BoardService,
    private readonly runs: RunsService,
    private readonly runners: RunnersService,
    private readonly onboarding: OnboardingAgent,
    private readonly specAgent: SpecAgent,
    private readonly build: BuildAgent,
  ) {}

  /** Station 02 — Ground. Opens one setup PR (or branch) per repository. */
  async runOnboarding(input: {
    projectId: string;
    repositoryIds: string[];
    actor: { userId: string; name: string };
  }) {
    await this.runs.assertCanRun(input.projectId);
    const project = await this.projects.byId(input.projectId);
    const ai = await this.connections.resolveAi(project.id, project.defaultModel);
    const model = this.resolveModel(ai.model, project.defaultModel);

    const pairedRunner =
      ai.mode === 'subscription_runner' ? await this.runners.pickPaired(project.id) : null;

    const results: {
      repositoryId: string;
      repoName: string;
      runId: string;
      branch?: string;
      url?: string | null;
      reviewHint?: string;
      fileCount?: number;
      error?: string;
      queued?: boolean;
    }[] = [];

    for (const repoId of input.repositoryIds) {
      const repo = await this.repositories.get(input.projectId, repoId);
      const run = await this.runs.start({
        projectId: input.projectId,
        kind: 'onboard',
        model,
        runner: ai.mode === 'subscription_runner' ? 'self_hosted' : 'hosted',
        triggeredByUserId: input.actor.userId,
        triggeredByName: input.actor.name,
        repositoryId: repo.id,
      });

      if (pairedRunner) {
        try {
          const prepared = await this.onboarding.prepare({ repo, projectName: project.name, run });
          const payload: OnboardJobPayload = {
            kind: 'onboard',
            system: prepared.system,
            user: prepared.user,
            schema: prepared.schema,
            model,
            maxTokens: 16_000,
            ctx: prepared.ctx,
          };
          await this.runs.queueForRunner(run.id, payload as unknown as Record<string, unknown>);
          await run.log(`queued for runner "${pairedRunner.name}" — waiting for it to poll`);
          results.push({ repositoryId: repo.id, repoName: repo.name, runId: run.id, queued: true });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await run.log(message, 'error');
          await this.runs.finish(run.id, { status: 'failed', error: message });
          this.logger.warn(`onboarding dispatch failed for ${repo.name}: ${message}`);
          results.push({ repositoryId: repo.id, repoName: repo.name, runId: run.id, error: message });
        }
        continue;
      }

      try {
        const result = await this.onboarding.run({
          repo,
          projectName: project.name,
          apiKey: ai.apiKey,
          model,
          mode: ai.mode,
          run,
        });
        await this.runs.finish(run.id, {
          status: 'succeeded',
          result: { branch: result.branch, url: result.url, files: result.fileCount },
        });
        results.push({
          repositoryId: repo.id,
          repoName: repo.name,
          runId: run.id,
          branch: result.branch,
          url: result.url,
          reviewHint: result.reviewHint,
          fileCount: result.fileCount,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await run.log(message, 'error');
        await this.runs.finish(run.id, { status: 'failed', error: message });
        this.logger.warn(`onboarding failed for ${repo.name}: ${message}`);
        results.push({ repositoryId: repo.id, repoName: repo.name, runId: run.id, error: message });
      }
    }

    return results;
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

  /** Station 06 — Learn. Re-index knowledge/ after a merge. */
  async reindex(input: {
    projectId: string;
    repositoryIds?: string[];
    actor: { userId: string; name: string } | null;
    /**
     * Who to credit when there is no signed-in user — "github webhook
     * (merged by alice)" rather than a blanket "scheduler". An automated
     * trigger is not a person, and the run log should not imply one.
     */
    triggeredByName?: string;
  }) {
    const repos = input.repositoryIds?.length
      ? await Promise.all(
          input.repositoryIds.map((id) => this.repositories.get(input.projectId, id)),
        )
      : await this.repositories.list(input.projectId);

    const run = await this.runs.start({
      projectId: input.projectId,
      kind: 'index',
      triggeredByUserId: input.actor?.userId ?? null,
      triggeredByName: input.actor?.name ?? input.triggeredByName ?? 'scheduler',
    });

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
