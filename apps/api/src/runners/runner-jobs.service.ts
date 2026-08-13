import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { agentRuns, type DbHandle, type Repository, type Runner } from '@specd/db';
import type { DetectedStack } from '@specd/templates';
import type {
  CitationCoverage,
  ModelId,
  RetrievedChunk,
  SpecContent,
  SpecView,
  TokenUsage,
} from '@specd/shared';
import { DB_HANDLE } from '../db/db.module.js';
import { RunsService } from '../runs/runs.service.js';
import { SpecAgent } from '../agents/spec.agent.js';
import {
  OnboardingAgent,
  type DraftedDocs,
  type PreparedOnboardCall,
} from '../agents/onboarding.agent.js';
import {
  BuildAgent,
  type BuildRunnerReport,
  type PreparedBuildTask,
} from '../agents/build.agent.js';
import { SpecsService } from '../specs/specs.service.js';
import { Config } from '../config.js';

/**
 * Run kinds a paired runner can execute and this service can finish. The
 * runner daemon keeps its own copy of this list; both must agree, and
 * `report()` throwing for anything else is the backstop if they ever do not.
 */
export const DISPATCHABLE_JOB_KINDS = ['spec', 'onboard', 'build'] as const;

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
  /** Captured with the retrieval, so a verdict reflects what the model saw. */
  coverage?: CitationCoverage;
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
  // Taken from the agent rather than restated, so the two cannot drift.
  ctx: PreparedOnboardCall['ctx'];
}

/**
 * What a runner receives when it claims a `build` job.
 *
 * Unlike the other two this is not "one prompt, one reply" — the runner runs
 * the whole edit/commit/verify/push loop, because each model call edits files
 * the next one reads, so there is no seam to split at
 * (`knowledge/decisions/0009-...`). Note what is *not* here: any credential.
 * The runner clones and pushes as itself.
 */
export interface BuildJobPayload {
  kind: 'build';
  model: ModelId;
  system: string;
  branch: string;
  asBuiltPath: string;
  asBuiltCommitMessage: string;
  verifyCommand: string | null;
  tasks: PreparedBuildTask[];
  remote: { cloneUrl: string; baseBranch: string };
  ticketKey: string;
  // Carried through to finalize(), which opens the review surface once the
  // runner reports the branch pushed. Neither field carries a secret.
  ctx: { repo: Repository; spec: SpecView };
}

export type JobPayload = SpecJobPayload | OnboardJobPayload | BuildJobPayload;

/** A line of narration from a running job, appended to the run log as it happens. */
export interface JobProgressLine {
  message: string;
  level?: 'info' | 'warn' | 'error';
}

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
 * elsewhere, report back.
 *
 * `spec` and `onboard` reduce to "call the model, hand back JSON," with all
 * VCS/DB work staying server-side. `build` is the exception: its loop is N
 * model calls with file edits between them, so the whole loop executes on the
 * runner, which clones and pushes with its own git credentials and never
 * receives one from specd (`knowledge/decisions/0009-...`). What comes back
 * is a finished result rather than something to finalize — the server's only
 * remaining job is opening the review surface.
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
    private readonly build: BuildAgent,
    private readonly specs: SpecsService,
    private readonly config: Config,
  ) {}

  /**
   * Narration from a job that is still running.
   *
   * A build takes minutes and logs continuously; without this the run's SSE
   * viewer would show nothing at all until it finished, for the one job kind
   * that most needs watching. Ownership is re-checked per call for the same
   * reason `report()` re-checks it: a claim is not a standing permission.
   */
  async progress(runner: Runner, runId: string, lines: JobProgressLine[]): Promise<void> {
    const [run] = await this.handle.db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
    if (!run) throw new NotFoundException('Run not found');
    if (run.runnerId !== runner.id) {
      // Also the zombie path (S-101): a runner that lost its lease reports
      // back after the job was reclaimed. Refusing here — without mutating
      // anything — is what makes reclaim safe.
      throw new ForbiddenException(
        'This run was not claimed by you (it may have been reclaimed after its lease expired)',
      );
    }
    if (run.status !== 'running') {
      throw new BadRequestException('This run is not running');
    }

    for (const line of lines) {
      await this.runs.logRun(runId, line.message, line.level ?? 'info');
    }
  }

  async claim(runner: Runner): Promise<ClaimedJob | null> {
    // Give up on jobs that have been reclaimed too many times before handing
    // out work — a job three runners have abandoned is telling us something,
    // and re-dispatching it forever is a crash loop with a queue in front.
    await this.failExhausted(runner);

    const lease = this.config.runnerLeaseSeconds;
    const buildLease = this.config.runnerLeaseBuildSeconds;

    // One atomic claim, now with two ways to match (S-101):
    //   queued   — the normal case, exactly as before.
    //   running  — a reclaim. Only when the job itself has been out longer
    //              than its kind's lease AND its owner has stopped
    //              heartbeating for that long too. Both signals must be
    //              stale: the daemon heartbeats every ~30s while executing,
    //              so a silent owner is a dead one — but claimed_at alone
    //              must never suffice, because a job claimed a moment ago
    //              by a runner that then went quiet deserves its full lease.
    //              A runner may also reclaim its OWN running job without the
    //              heartbeat check — the daemon runs one job at a time, so
    //              the owner polling for new work means it lost the old one
    //              (crash + restart); its own polling keeps last_seen_at
    //              fresh, which would otherwise block that recovery forever.
    // In-process runs are excluded by construction: they never have a
    // job_payload, and their runner_id is NULL.
    // FOR UPDATE SKIP LOCKED is unchanged — two concurrent pollers still
    // cannot claim the same row; the loser's subquery skips the locked row.
    const rows = await this.handle.sql<
      {
        id: string;
        kind: string;
        job_payload: JobPayload | null;
        reclaim_count: number;
        prev_status: string;
        prev_runner_name: string | null;
      }[]
    >`
      WITH candidate AS (
        SELECT ar.id, ar.status AS prev_status, r.name AS prev_runner_name
        FROM agent_runs ar
        LEFT JOIN runners r ON r.id = ar.runner_id
        WHERE ar.project_id = ${runner.projectId}
          AND ar.job_payload IS NOT NULL
          -- Only kinds this service can actually finish. Keying on the payload
          -- alone was enough while nothing else carried one, but index runs now
          -- do (0012) and a runner claiming one would strand it: report() has
          -- no finisher for the kind and would throw.
          AND ar.kind = ANY(${[...DISPATCHABLE_JOB_KINDS]})
          AND (
            (ar.status = 'queued' AND ar.runner_id IS NULL)
            OR (
              ar.status = 'running'
              AND ar.runner_id IS NOT NULL
              AND ar.reclaim_count < ${this.config.runnerMaxReclaims}
              AND ar.claimed_at < now() - make_interval(secs => (CASE WHEN ar.kind = 'build' THEN ${buildLease} ELSE ${lease} END)::float8)
              AND (
                ar.runner_id = ${runner.id}
                OR r.last_seen_at < now() - make_interval(secs => (CASE WHEN ar.kind = 'build' THEN ${buildLease} ELSE ${lease} END)::float8)
              )
            )
          )
        ORDER BY CASE WHEN ar.status = 'queued' THEN 0 ELSE 1 END, ar.created_at
        LIMIT 1
        FOR UPDATE OF ar SKIP LOCKED
      )
      UPDATE agent_runs
      SET runner_id = ${runner.id},
          claimed_at = now(),
          status = 'running',
          reclaim_count = reclaim_count + CASE WHEN candidate.prev_status = 'running' THEN 1 ELSE 0 END
      FROM candidate
      WHERE agent_runs.id = candidate.id
      RETURNING agent_runs.id, agent_runs.kind, agent_runs.job_payload,
                agent_runs.reclaim_count, candidate.prev_status, candidate.prev_runner_name
    `;

    const row = rows[0];
    if (!row || !row.job_payload) return null;

    if (row.prev_status === 'running') {
      // The takeover is news the person watching the run needs — surfaced in
      // the same run-log/SSE stream everything else uses.
      await this.runs.logRun(
        row.id,
        `reclaimed from unresponsive runner "${row.prev_runner_name ?? 'unknown'}" ` +
          `(reclaim ${row.reclaim_count} of ${this.config.runnerMaxReclaims}) — ` +
          `re-running from scratch on "${runner.name}"`,
        'warn',
      );
    }

    return { id: row.id, kind: row.kind, payload: row.job_payload };
  }

  /**
   * Fail runs whose lease expired after the last allowed reclaim. Failing —
   * not silently dropping — keeps the requirement that the user can retry
   * from the UI: a failed build leaves its spec in `building`, which is still
   * buildable, and a failed spec draft leaves the ticket ready to generate
   * again.
   */
  private async failExhausted(runner: Runner): Promise<void> {
    const lease = this.config.runnerLeaseSeconds;
    const buildLease = this.config.runnerLeaseBuildSeconds;

    const exhausted = await this.handle.sql<{ id: string; reclaim_count: number }[]>`
      SELECT ar.id, ar.reclaim_count
      FROM agent_runs ar
      LEFT JOIN runners r ON r.id = ar.runner_id
      WHERE ar.project_id = ${runner.projectId}
        AND ar.status = 'running'
        AND ar.runner_id IS NOT NULL
        AND ar.job_payload IS NOT NULL
        AND ar.reclaim_count >= ${this.config.runnerMaxReclaims}
        AND ar.claimed_at < now() - make_interval(secs => (CASE WHEN ar.kind = 'build' THEN ${buildLease} ELSE ${lease} END)::float8)
        AND (r.last_seen_at IS NULL OR r.last_seen_at < now() - make_interval(secs => (CASE WHEN ar.kind = 'build' THEN ${buildLease} ELSE ${lease} END)::float8))
      FOR UPDATE OF ar SKIP LOCKED
    `;

    for (const run of exhausted) {
      await this.runs.logRun(
        run.id,
        `abandoned by ${run.reclaim_count + 1} runner(s) in a row — giving up rather than looping. ` +
          'Retry from the UI once a runner is healthy.',
        'error',
      );
      await this.runs.finish(run.id, {
        status: 'failed',
        error: `Job was repeatedly abandoned (${run.reclaim_count} reclaim(s) exhausted). A runner kept dying mid-job.`,
      });
    }
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
      // The zombie path (S-101): a runner that lost its lease wakes up and
      // reports a job that was reclaimed meanwhile. Refused without mutating
      // the run — the new owner's report is the only one that counts, which
      // is what makes replaying a reclaimed job safe.
      throw new ForbiddenException(
        'This run was not claimed by you (it may have been reclaimed after its lease expired)',
      );
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
        coverage: payload.coverage,
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

    if (run.kind === 'build') {
      const payload = run.jobPayload as unknown as BuildJobPayload | null;
      if (!payload) throw new BadRequestException('This run has no stored job payload to finalize against');

      // The runner already pushed the branch with its own credentials; the
      // only thing left that needs a platform token is the review surface.
      const result = await this.build.finalize(outcome.parsed as BuildRunnerReport, {
        repo: payload.ctx.repo,
        spec: payload.ctx.spec,
        prepared: {
          branch: payload.branch,
          asBuiltPath: payload.asBuiltPath,
          verifyCommand: payload.verifyCommand,
          remote: payload.remote,
        },
      });

      await this.runs.logRun(runId, `branch ${result.branch} ready · ${result.commits} commit(s) (via ${runner.name})`);
      await this.runs.logRun(
        runId,
        'merge the branch to complete the loop — the as-built spec re-indexes on merge',
      );
      await this.runs.finish(runId, { status: 'succeeded', result: { ...result } });
      return;
    }

    // Every dispatchable job kind is handled above — this guards against a
    // future job kind being reported through a finisher that does not know
    // it yet, rather than silently mis-finalizing it.
    throw new BadRequestException(`No finisher for job kind "${run.kind}"`);
  }
}
