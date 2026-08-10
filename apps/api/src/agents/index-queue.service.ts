import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { DbHandle, Unlisten } from '@specd/db';
import { DB_HANDLE } from '../db/db.module.js';
import { Config } from '../config.js';
import { RunsService } from '../runs/runs.service.js';

/**
 * The channel a queued index run announces itself on. Postgres holds a NOTIFY
 * until its transaction commits, so a listener woken by this can always see
 * the row that woke it.
 */
export const INDEX_QUEUE_CHANNEL = 'specd_index_queued';

interface ClaimedRun {
  id: string;
  projectId: string;
  repositoryIds: string[];
  wasStale: boolean;
}

/**
 * Runs the index work that used to happen inside webhook requests (0012).
 *
 * Woken by LISTEN/NOTIFY rather than polled, but never *dependent* on being
 * woken: NOTIFY delivers nothing to a disconnected listener, so the run row is
 * the source of truth and a notification only decides when to look. A slow
 * safety tick and a drain at startup cover the gaps — if notifications stopped
 * entirely, indexing would slow to the tick rather than stop.
 *
 * Claiming is `FOR UPDATE SKIP LOCKED`, the same shape runner dispatch uses
 * (per knowledge/decisions/0004-runner-job-dispatch.md#decision), so several
 * API instances can listen to the same channel without racing.
 */
@Injectable()
export class IndexQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IndexQueueService.name);
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
    if (!this.config.indexWorkerEnabled) {
      this.logger.log('index worker disabled — queued index runs will not be executed here');
      return;
    }

    try {
      this.unlisten = await this.handle.listen(
        INDEX_QUEUE_CHANNEL,
        () => void this.drain(),
        // Fires on every (re)subscribe. A reconnect may have missed
        // notifications, so the only safe assumption is that work is waiting.
        () => void this.drain(),
      );
    } catch (err) {
      // A listener that will not start is a degradation, not an outage: the
      // safety tick below still drains. Say so rather than failing boot.
      this.logger.warn(
        `LISTEN ${INDEX_QUEUE_CHANNEL} failed (${err instanceof Error ? err.message : String(err)}) — ` +
          `falling back to the ${this.config.indexPollMs}ms safety tick`,
      );
    }

    this.timer = setInterval(() => void this.drain(), this.config.indexPollMs);
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
    await this.handle.notify(INDEX_QUEUE_CHANNEL).catch((err: unknown) => {
      // Losing the nudge costs latency, never correctness — the row is still
      // queued and the next tick picks it up.
      this.logger.warn(
        `NOTIFY ${INDEX_QUEUE_CHANNEL} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /**
   * Claim and execute queued index runs until none are left. Re-entrant calls
   * collapse into the in-flight one rather than running concurrently.
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
              `claiming an index run failed: ${err instanceof Error ? err.message : String(err)}`,
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
   * One queued run, or one whose executor died holding it. The lease is
   * generous because an index run is a single long transaction rather than a
   * job that heartbeats.
   */
  private async claim(): Promise<ClaimedRun | null> {
    const rows = await this.handle.sql<
      {
        id: string;
        project_id: string;
        job_payload: { repositoryIds?: string[] } | null;
        prev_status: string;
      }[]
    >`
      WITH candidate AS (
        SELECT ar.id, ar.status AS prev_status
        FROM agent_runs ar
        WHERE ar.kind = 'index'
          AND (
            ar.status = 'queued'
            OR (
              ar.status = 'running'
              AND ar.started_at < now() - make_interval(secs => ${this.config.indexLeaseSeconds}::float8)
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
      RETURNING agent_runs.id, agent_runs.project_id, agent_runs.job_payload,
                candidate.prev_status
    `;

    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      projectId: row.project_id,
      repositoryIds: row.job_payload?.repositoryIds ?? [],
      wasStale: row.prev_status === 'running',
    };
  }

  private async execute(run: ClaimedRun): Promise<void> {
    if (run.wasStale) {
      // Someone has been waiting on a run whose executor never came back.
      // Say so in the run's own log, where the person watching it will look.
      await this.runs
        .logRun(run.id, 'restarted — the previous attempt stopped without finishing', 'warn')
        .catch(() => undefined);
    }

    // Resolved lazily to keep this service out of PipelineService's
    // constructor cycle: the pipeline enqueues, this executes.
    const { PipelineService } = await import('./pipeline.service.js');
    const pipeline = this.moduleRef.get(PipelineService, { strict: false });

    try {
      await pipeline.runReindex({
        runId: run.id,
        projectId: run.projectId,
        repositoryIds: run.repositoryIds,
      });
    } catch (err) {
      // runReindex already logged and finished the run as failed; this is the
      // server-side record that the worker survived it.
      this.logger.warn(
        `index run ${run.id} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
