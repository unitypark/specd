import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { agentRuns, type DbHandle, type Runner } from '@specd/db';
import type { ModelId, RetrievedChunk, SpecContent, TokenUsage } from '@specd/shared';
import { DB_HANDLE } from '../db/db.module.js';
import { RunsService } from '../runs/runs.service.js';
import { SpecAgent } from '../agents/spec.agent.js';
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

export type JobPayload = SpecJobPayload;

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
 * elsewhere, report back. Only `spec` jobs are dispatchable today — see
 * `knowledge/decisions/0003-runner-pairing-before-dispatch.md` for why
 * `onboard`/`build` (both of which also need git, not just a model call)
 * are a deliberately separate follow-up.
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

    if (run.kind !== 'spec') {
      // Every job queued today is a spec job — this guards against a future
      // job kind being reported through a finisher that does not know it yet,
      // rather than silently mis-finalizing it as a spec.
      throw new BadRequestException(`No finisher for job kind "${run.kind}"`);
    }

    const payload = run.jobPayload as unknown as SpecJobPayload | null;
    if (!payload) throw new BadRequestException('This run has no stored job payload to finalize against');

    await this.runs.meterRun(runId, outcome.model, outcome.usage, outcome.billable ?? false);

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
  }
}
