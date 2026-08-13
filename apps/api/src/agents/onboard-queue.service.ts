import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { DbHandle, Unlisten } from '@specd/db';
import { DB_HANDLE } from '../db/db.module.js';
import { Config } from '../config.js';
import { RunsService } from '../runs/runs.service.js';

/**
 * The channel a queued onboarding run announces itself on. As with the index
 * queue, Postgres holds a NOTIFY until its transaction commits, so a listener
 * woken by this can always see the row that woke it.
 */
export const ONBOARD_QUEUE_CHANNEL = 'specd_onboard_queued';

interface ClaimedRun {
  id: string;
  projectId: string;
  repositoryId: string | null;
  wasStale: boolean;
}

/**
 * Executes the grounding work that used to happen inside the `POST
 * /projects/:slug/onboard` request (0016).
 *
 * Structurally this is [[0012-index-runs-queued-and-woken-by-listen-notify]]'s
 * worker applied to a second kind: woken by LISTEN/NOTIFY, never dependent on
 * being woken, drained at startup and on a slow safety tick, claimed with
 * `FOR UPDATE SKIP LOCKED` so several API instances can listen to one channel
 * without racing.
 *
 * It differs from the index worker in the two places grounding differs from
 * indexing, and both are load-bearing:
 *
 * 1. **The claim filters on `runner = 'hosted'`.** `onboard` is a dispatchable
 *    kind (0005), so once this worker prepares a prompt and calls
 *    `queueForRunner`, the row goes back to `queued` for a *paired runner* to
 *    claim. Without this filter that row is indistinguishable from fresh work
 *    and this worker would take it straight back.
 * 2. **An abandoned run is failed, not restarted.** Indexing is idempotent;
 *    grounding ends by opening a pull request, and is not.
 */
@Injectable()
export class OnboardQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OnboardQueueService.name);
  private unlisten: Unlisten | null = null;
  private timer: NodeJS.Timeout | null = null;
  private draining = false;
  /** Set while draining if a wake arrives mid-drain, so nothing is missed. */
  private redrain = false;
  private stopped = false;

  constructor(
    @Inject(DB_HANDLE) private readonly handle: DbHandle,
    private readonly config: Config,
    private readonly runs: RunsService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.onboardWorkerEnabled) {
      this.logger.log('onboard worker disabled — queued onboarding runs will not be executed here');
      return;
    }

    try {
      this.unlisten = await this.handle.listen(
        ONBOARD_QUEUE_CHANNEL,
        () => void this.drain(),
        // Fires on every (re)subscribe. A reconnect may have missed
        // notifications, so the only safe assumption is that work is waiting.
        () => void this.drain(),
      );
    } catch (err) {
      // A listener that will not start is a degradation, not an outage: the
      // safety tick below still drains. Say so rather than failing boot.
      this.logger.warn(
        `LISTEN ${ONBOARD_QUEUE_CHANNEL} failed (${err instanceof Error ? err.message : String(err)}) — ` +
          `falling back to the ${this.config.onboardPollMs}ms safety tick`,
      );
    }

    this.timer = setInterval(() => void this.drain(), this.config.onboardPollMs);
    this.timer.unref?.();
    void this.drain();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.unlisten) await this.unlisten().catch(() => undefined);
  }

  /** Tell whoever is listening that there is work. */
  async wake(): Promise<void> {
    await this.handle.notify(ONBOARD_QUEUE_CHANNEL).catch((err: unknown) => {
      // Losing the nudge costs latency, never correctness — the row is still
      // queued and the next tick picks it up.
      this.logger.warn(
        `NOTIFY ${ONBOARD_QUEUE_CHANNEL} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /**
   * Claim and execute queued onboarding runs until none are left. Re-entrant
   * calls collapse into the in-flight one rather than running concurrently.
   */
  async drain(): Promise<void> {
    if (this.stopped) return;
    if (this.draining) {
      this.redrain = true;
      return;
    }
    this.draining = true;

    try {
      do {
        this.redrain = false;
        for (;;) {
          const claimed = await this.claim().catch((err: unknown) => {
            this.logger.error(
              `claiming an onboarding run failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            return null;
          });
          if (!claimed) break;
          await this.execute(claimed);
          if (this.stopped) return;
        }
      } while (this.redrain);
    } finally {
      this.draining = false;
    }
  }

  /**
   * One queued run, or one whose executor died holding it.
   *
   * `runner = 'hosted'` is the whole reason a dispatched job stays dispatched:
   * a run this worker hands to a paired runner is set `self_hosted` and goes
   * back to `queued` for the runner to poll for, and must not be visible here
   * again. The lease is generous because an onboarding run is one long read
   * plus a model call rather than a job that heartbeats.
   */
  private async claim(): Promise<ClaimedRun | null> {
    const rows = await this.handle.sql<
      {
        id: string;
        project_id: string;
        repository_id: string | null;
        prev_status: string;
      }[]
    >`
      WITH candidate AS (
        SELECT ar.id, ar.status AS prev_status
        FROM agent_runs ar
        WHERE ar.kind = 'onboard'
          AND ar.runner = 'hosted'
          AND (
            ar.status = 'queued'
            OR (
              ar.status = 'running'
              AND ar.started_at < now() - make_interval(secs => ${this.config.onboardLeaseSeconds}::float8)
            )
          )
        ORDER BY CASE WHEN ar.status = 'queued' THEN 0 ELSE 1 END, ar.created_at
        LIMIT 1
        FOR UPDATE OF ar SKIP LOCKED
      )
      UPDATE agent_runs
      SET status = 'running', started_at = now()
      FROM candidate
      WHERE agent_runs.id = candidate.id
      RETURNING agent_runs.id, agent_runs.project_id, agent_runs.repository_id,
                candidate.prev_status
    `;

    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      projectId: row.project_id,
      repositoryId: row.repository_id,
      wasStale: row.prev_status === 'running',
    };
  }

  private async execute(run: ClaimedRun): Promise<void> {
    if (run.wasStale) {
      // Deliberately not restarted, which is where this parts company with the
      // index worker. Grounding ends in `adapter.propose()`: it force-resets
      // the fixed `specd/setup` branch and then POSTs a pull request with no
      // handling for one that is already open (unlike `openPullRequest`, which
      // the build station needs to be re-runnable). So an executor that died
      // after proposing would, on restart, pay for a second model call and
      // then fail at the PR. Failing the run says what happened and leaves the
      // repository free for a human to ground again.
      await this.fail(
        run.id,
        'the previous attempt stopped without finishing — onboarding is not resumed ' +
          'automatically, because it may already have opened a setup PR. Start it again ' +
          'from the setup page once you have checked.',
      );
      return;
    }

    if (!run.repositoryId) {
      // `enqueueOnboarding` always sets one; the column is nullable for kinds
      // that have no repository, so this is a corrupt row rather than a case.
      await this.fail(run.id, 'this onboarding run names no repository and cannot be executed');
      return;
    }

    // Resolved lazily to keep this service out of PipelineService's
    // constructor cycle: the pipeline enqueues, this executes.
    const { PipelineService } = await import('./pipeline.service.js');
    const pipeline = this.moduleRef.get(PipelineService, { strict: false });

    try {
      await pipeline.runOnboardingRun({
        runId: run.id,
        projectId: run.projectId,
        repositoryId: run.repositoryId,
      });
    } catch (err) {
      // runOnboardingRun already logged and finished the run as failed; this is
      // the server-side record that the worker survived it.
      this.logger.warn(
        `onboarding run ${run.id} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Finish a run the worker refuses to execute, saying so in its own log. */
  private async fail(runId: string, reason: string): Promise<void> {
    await this.runs.logRun(runId, reason, 'error').catch(() => undefined);
    await this.runs.finish(runId, { status: 'failed', error: reason }).catch(() => undefined);
  }
}
