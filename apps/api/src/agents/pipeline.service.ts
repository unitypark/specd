import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { isModelId, type ModelId, type SpecView } from '@specd/shared';
import { ProjectsService } from '../projects/projects.service.js';
import { RepositoriesService } from '../projects/repositories.service.js';
import { ConnectionsService } from '../projects/connections.service.js';
import { KnowledgeService } from '../knowledge/knowledge.service.js';
import { SpecsService } from '../specs/specs.service.js';
import { BoardService } from '../board/board.service.js';
import { RunsService } from '../runs/runs.service.js';
import { OnboardingAgent } from './onboarding.agent.js';
import { SpecAgent } from './spec.agent.js';

/**
 * Orchestration. Each public method here is one station of the fixed pipeline
 * (D11) and shares the same shape:
 *
 *   check the gate/cap → open an auditable run → do the work → meter → finish
 *
 * Runs are executed in-process and awaited. That is honest for P1: a spec
 * draft is a single model call, and pretending it is a distributed job would
 * add a queue with nothing to schedule. The BullMQ worker in `queue/` takes
 * over for the long-running build station in P2 without changing this surface.
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
    private readonly onboarding: OnboardingAgent,
    private readonly specAgent: SpecAgent,
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

    const results: {
      repositoryId: string;
      repoName: string;
      runId: string;
      branch?: string;
      url?: string | null;
      reviewHint?: string;
      fileCount?: number;
      error?: string;
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

      try {
        const result = await this.onboarding.run({
          repo,
          projectName: project.name,
          apiKey: ai.apiKey,
          model,
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
  }): Promise<{ spec: SpecView; runId: string }> {
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

    const run = await this.runs.start({
      projectId: input.projectId,
      kind: 'spec',
      model,
      runner: ai.mode === 'subscription_runner' ? 'self_hosted' : 'hosted',
      triggeredByUserId: input.actor.userId,
      triggeredByName: input.actor.name,
      ticketId: ticket.id,
    });

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

  /** Station 06 — Learn. Re-index knowledge/ after a merge. */
  async reindex(input: {
    projectId: string;
    repositoryIds?: string[];
    actor: { userId: string; name: string } | null;
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
      triggeredByName: input.actor?.name ?? 'scheduler',
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
