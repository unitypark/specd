import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { agentRuns, type DbHandle, type Repository, type Runner } from '@specd/db';
import type { DetectedStack } from '@specd/templates';
import type { ModelId, RetrievedChunk, SpecContent, TokenUsage } from '@specd/shared';
import { DB_HANDLE } from '../db/db.module.js';
import { RunsService } from '../runs/runs.service.js';
import { SpecAgent } from '../agents/spec.agent.js';
import { OnboardingAgent, type DraftedDocs } from '../agents/onboarding.agent.js';
import { SpecsService } from '../specs/specs.service.js';

/** What a runner receives when it claims a `spec` job — everything `SpecAgent.prepare()` produced. */
export interface SpecJobPayload {
  kind: 'spec';
  system: string;
  user: string;
  schema: Record<string, unknown>;
  model: ModelId;
  maxTokens: number;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  // Carried through to finalize() once the runner reports a result — the
  // runner itself never needs to understand any of this, only echo the
  // model's reply back.
  chunks: RetrievedChunk[];
  slug: string;
  ticketKey: string;
  ticketId: string;
  primaryRepo: string;
  projectId: string;
}

/** What a runner receives when it claims an `onboard` job — everything `OnboardingAgent.prepare()` produced. */
export interface OnboardJobPayload {
  kind: 'onboard';
  system: string;
  user: string;
  schema: Record<string, unknown>;
  model: ModelId;
  maxTokens: number;
  // Carried through to finalize() — the propose()/db-write half never needs
  // a runner at all (it is a VCS REST call with a platform-held token, not a
  // git checkout), so it happens back on the server once the draft returns.
  ctx: {
    repo: Repository;
    projectName: string;
    stack: DetectedStack;
    topLevelDirs: string[];
    entryPoints: string[];
  };
}

export type JobPayload = SpecJobPayload | OnboardJobPayload;

export interface ClaimedJob {
  id: string;
  kind: string;
  payload: JobPayload;
}

export type JobReport =
  | { status: 'succeeded'; parsed: unknown; model: ModelId; usage: TokenUsage; billable?: boolean }
  | { status: 'failed'; error: string };

/**
 * The runner's half of the pipeline: claim a queued job, execute it
 * elsewhere, report back. `spec` and `onboard` are dispatchable — both
 * reduce to "call the model, hand back JSON," with all VCS/DB work staying
 * server-side either way. `build` is not: it needs a real git checkout
 * (`WorkspaceService`) on the runner's own machine, which is a deliberately
 * separate follow-up (`knowledge/decisions/0004-runner-job-dispatch.md`).
 *
 * Claiming is a single atomic `UPDATE ... WHERE id = (SELECT ... FOR UPDATE
 * SKIP LOCKED)`, expressed as raw SQL because that shape does not fit
 * Drizzle's query builder — the same reason `KnowledgeService` reaches for
 * `DB_HANDLE` instead of the wrapped `DB`. Two runners polling the same
 * project at once cannot claim the same row: the loser's subquery simply
 * returns nothing, because Postgres skips a row already locked by the winner
 * rather than blocking on it.
 */
@Injectable()
export class RunnerJobsService {
  constructor(
    @Inject(DB_HANDLE) private readonly handle: DbHandle,
    private readonly runs: RunsService,
    private readonly specAgent: SpecAgent,
    private readonly onboarding: OnboardingAgent,
    private readonly specs: SpecsService,
  ) {}

  async claim(runner: Runner): Promise<ClaimedJob | null> {
    const rows = await this.handle.sql<
      { id: string; kind: string; job_payload: JobPayload | null }[]
    >`
      UPDATE agent_runs
      SET runner_id = ${runner.id}, claimed_at = now(), status = 'running'
      WHERE id = (
        SELECT id FROM agent_runs
        WHERE project_id = ${runner.projectId}
          AND status = 'queued'
          AND runner_id IS NULL
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, kind, job_payload
    `;

    const row = rows[0];
    if (!row || !row.job_payload) return null;
    return { id: row.id, kind: row.kind, payload: row.job_payload };
  }

  /**
   * The runner's result, however it turned out. Ownership is re-checked here
   * — not trusted from the claim — so a runner can only ever finish a job it
   * actually claimed, and a run that already finished (a duplicate report,
   * a retry racing a timeout) is refused rather than double-processed.
   */
  async report(runner: Runner, runId: string, outcome: JobReport): Promise<void> {
    const [run] = await this.handle.db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
    if (!run) throw new NotFoundException('Run not found');
    if (run.runnerId !== runner.id) {
      throw new ForbiddenException('This run was not claimed by you');
    }
    if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') {
      throw new BadRequestException('This run has already finished');
    }

    if (outcome.status === 'failed') {
      await this.runs.finish(runId, { status: 'failed', error: outcome.error });
      return;
    }

    await this.runs.meterRun(runId, outcome.model, outcome.usage, outcome.billable ?? false);

    if (run.kind === 'spec') {
      const payload = run.jobPayload as unknown as SpecJobPayload | null;
      if (!payload) throw new BadRequestException('This run has no stored job payload to finalize against');

      const content = this.specAgent.finalize(outcome.parsed as SpecContent | undefined, payload.chunks, {
        ticketKey: payload.ticketKey,
        slug: payload.slug,
        primaryRepo: payload.primaryRepo,
      });

      const spec = await this.specs.createVersion({
        projectId: payload.projectId,
        ticketId: payload.ticketId,
        content,
        createdByRunId: runId,
      });

      await this.runs.logRun(runId, `spec v${spec.version} published to the board ✓ (via ${runner.name})`);
      await this.runs.finish(runId, {
        status: 'succeeded',
        result: { specId: spec.id, version: spec.version },
      });
      return;
    }

    if (run.kind === 'onboard') {
      const payload = run.jobPayload as unknown as OnboardJobPayload | null;
      if (!payload) throw new BadRequestException('This run has no stored job payload to finalize against');

      const result = await this.onboarding.finalize(
        (outcome.parsed as DraftedDocs | undefined) ?? null,
        payload.ctx,
        (message, level) => this.runs.logRun(runId, message, level),
      );

      await this.runs.logRun(runId, `${result.reviewHint} (via ${runner.name})`);
      await this.runs.finish(runId, {
        status: 'succeeded',
        result: { branch: result.branch, url: result.url, files: result.fileCount },
      });
      return;
    }

    // Every dispatchable job kind is handled above — this guards against a
    // future job kind being reported through a finisher that does not know
    // it yet, rather than silently mis-finalizing it.
    throw new BadRequestException(`No finisher for job kind "${run.kind}"`);
  }
}
