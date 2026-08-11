import { EventEmitter } from 'node:events';
import {
  Inject,
  Injectable,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { agentRuns, runLogs, type Db, type DbHandle } from '@specd/db';
import {
  costEurCents,
  type AgentRunKind,
  type ModelId,
  type RunLogLine,
  type TokenUsage,
} from '@specd/shared';
import { DB, DB_HANDLE } from '../db/db.module.js';
import { Config } from '../config.js';
import { redactSecrets } from '../common/vault.js';
import { AgentsPaused, SpendCapExceeded } from '../common/errors.js';
import { ProjectsService } from '../projects/projects.service.js';

export interface RunHandle {
  id: string;
  log: (message: string, level?: 'info' | 'warn' | 'error') => Promise<void>;
  /** `billable: false` records tokens but no cost (subscription mode, D2). */
  meter: (model: ModelId, usage: TokenUsage, billable?: boolean) => Promise<void>;
}

/**
 * Every agent interaction is an auditable AgentRun (§10): who triggered it,
 * which model, how many tokens, what it cost, and the full log. Immutable
 * once finished.
 */
/**
 * Channel a run announces new log lines on. The payload is the run id and
 * whether it just finished — never the line itself. A viewer re-reads from
 * `run_logs` by sequence, so the table stays the truth and a notification only
 * decides when to look (the same contract as the index queue, 0012).
 */
export const RUN_LOG_CHANNEL = 'specd_run_log';

@Injectable()
export class RunsService implements OnModuleInit, OnModuleDestroy {
  /**
   * Fan-out to live viewers *in this process*. Kept as a fast path alongside
   * the Postgres channel: if LISTEN cannot start, a single-instance deployment
   * still streams. Both paths trigger the same sequence-based read, so being
   * poked twice delivers each line once.
   */
  private readonly bus = new EventEmitter();
  private unlisten: (() => Promise<void>) | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(DB_HANDLE) private readonly handle: DbHandle,
    private readonly config: Config,
    private readonly projects: ProjectsService,
  ) {
    this.bus.setMaxListeners(0);
  }

  async onModuleInit(): Promise<void> {
    try {
      this.unlisten = await this.handle.listen(RUN_LOG_CHANNEL, (payload) => {
        try {
          const { r, e } = JSON.parse(payload) as { r: string; e?: boolean };
          this.bus.emit(r, Boolean(e));
        } catch {
          // A payload we cannot read is not worth taking the listener down for.
        }
      });
    } catch {
      // Degraded, not broken: viewers attached to this process still stream
      // from the local bus. Only cross-instance fan-out is lost.
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.unlisten) await this.unlisten().catch(() => undefined);
  }

  /** Tell every instance that this run has new lines, or has ended. */
  private announce(runId: string, ended = false): void {
    this.bus.emit(runId, ended);
    void this.handle
      .notify(RUN_LOG_CHANNEL, JSON.stringify({ r: runId, e: ended }))
      .catch(() => undefined);
  }

  /**
   * Caps are enforced *before* the run, not after it overspends (§12). A run
   * that would start over budget never starts.
   */
  async assertCanRun(projectId: string): Promise<void> {
    const project = await this.projects.byId(projectId);
    if (project.agentsPaused) throw new AgentsPaused();

    const spent = await this.projects.monthlySpendCents(projectId);
    if (spent >= project.spendCapCents) {
      throw new SpendCapExceeded(spent, project.spendCapCents);
    }
  }

  async start(input: {
    projectId: string;
    kind: AgentRunKind;
    model?: string | null;
    runner?: 'hosted' | 'self_hosted';
    triggeredByUserId?: string | null;
    triggeredByName?: string | null;
    ticketId?: string | null;
    repositoryId?: string | null;
  }): Promise<RunHandle> {
    const [row] = await this.db
      .insert(agentRuns)
      .values({
        projectId: input.projectId,
        kind: input.kind,
        model: input.model ?? null,
        runner: input.runner ?? 'hosted',
        status: 'running',
        triggeredByUserId: input.triggeredByUserId ?? null,
        triggeredByName: input.triggeredByName ?? null,
        ticketId: input.ticketId ?? null,
        repositoryId: input.repositoryId ?? null,
        startedAt: new Date(),
      })
      .returning({ id: agentRuns.id });

    if (!row) throw new Error('failed to create agent run');
    const runId = row.id;
    let seq = 0;

    const log = async (message: string, level: 'info' | 'warn' | 'error' = 'info') => {
      // Redacted on the way in — logs are archived, so a secret that reaches
      // storage is a secret that leaked (§12).
      const safe = redactSecrets(message);
      const line: RunLogLine = { at: new Date().toISOString(), level, message: safe };
      seq += 1;
      await this.db.insert(runLogs).values({ runId, seq, level, message: safe });
      void line;
      this.announce(runId);
    };

    const meter = async (model: ModelId, usage: TokenUsage, billable = true) =>
      this.meterRun(runId, model, usage, billable);

    return { id: runId, log, meter };
  }

  /**
   * Create a run that is waiting to be picked up rather than already running
   * (0012). Unlike `queueForRunner` this is the run's *first* state: nothing
   * has happened yet, and `startedAt` stays null until something claims it.
   */
  async enqueue(input: {
    projectId: string;
    kind: AgentRunKind;
    triggeredByUserId?: string | null;
    triggeredByName?: string | null;
    repositoryId?: string | null;
    jobPayload?: Record<string, unknown> | null;
  }): Promise<string> {
    const [row] = await this.db
      .insert(agentRuns)
      .values({
        projectId: input.projectId,
        kind: input.kind,
        runner: 'hosted',
        status: 'queued',
        triggeredByUserId: input.triggeredByUserId ?? null,
        triggeredByName: input.triggeredByName ?? null,
        repositoryId: input.repositoryId ?? null,
        jobPayload: input.jobPayload ?? null,
      })
      .returning({ id: agentRuns.id });

    if (!row) throw new Error('failed to enqueue agent run');
    return row.id;
  }

  /**
   * A queued index run for this project, if one is already waiting (0012).
   * Only `queued` counts: a run already executing has passed the point where
   * a new request could be folded into it.
   */
  async pendingIndexRun(projectId: string): Promise<{ id: string; repositoryIds: string[] } | null> {
    const [row] = await this.db
      .select({ id: agentRuns.id, jobPayload: agentRuns.jobPayload })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.projectId, projectId),
          eq(agentRuns.kind, 'index'),
          eq(agentRuns.status, 'queued'),
        ),
      )
      .orderBy(agentRuns.createdAt)
      .limit(1);

    if (!row) return null;
    const payload = row.jobPayload as { repositoryIds?: string[] } | null;
    return { id: row.id, repositoryIds: payload?.repositoryIds ?? [] };
  }

  /**
   * Widen a queued index run to also cover `repositoryIds`. An empty list
   * means "every repository in the project", so it absorbs any narrower scope
   * rather than being narrowed by it.
   */
  async widenIndexScope(runId: string, repositoryIds: string[]): Promise<void> {
    const [row] = await this.db
      .select({ jobPayload: agentRuns.jobPayload })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);

    const current = (row?.jobPayload as { repositoryIds?: string[] } | null)?.repositoryIds ?? [];
    const widened =
      current.length === 0 || repositoryIds.length === 0
        ? []
        : [...new Set([...current, ...repositoryIds])];

    await this.db
      .update(agentRuns)
      .set({ jobPayload: { repositoryIds: widened } })
      .where(eq(agentRuns.id, runId));
  }

  /**
   * A `RunHandle` for a run that already exists — the counterpart to `logRun`
   * and `meterRun` for a caller that wants the same interface `start()` gives.
   * Sequence numbers come from the table rather than a closure, because the
   * process that created the run is not the one holding this handle.
   */
  handleFor(runId: string): RunHandle {
    return {
      id: runId,
      log: (message: string, level: 'info' | 'warn' | 'error' = 'info') =>
        this.logRun(runId, message, level),
      meter: (model: ModelId, usage: TokenUsage, billable = true) =>
        this.meterRun(runId, model, usage, billable),
    };
  }

  /**
   * Move an already-created run into the queue for a self-hosted runner to
   * claim, carrying everything the runner needs to execute it and everything
   * this service needs to finish it once a result comes back. Used instead of
   * `start()` finishing synchronously when a paired runner exists — the run
   * still gets a `RunHandle` from `start()` first, so preparation (retrieval,
   * prompt assembly) logs exactly the way the synchronous path already does.
   */
  async queueForRunner(runId: string, jobPayload: Record<string, unknown>): Promise<void> {
    await this.db
      .update(agentRuns)
      .set({ status: 'queued', runner: 'self_hosted', jobPayload })
      .where(eq(agentRuns.id, runId));
  }

  /** The direct-by-id counterpart to a `RunHandle`'s `meter` — for a run
   *  whose original handle is gone, as it is once a job dispatch reports back. */
  async meterRun(runId: string, model: ModelId, usage: TokenUsage, billable = true): Promise<void> {
    // Subscription runs consume quota, not euros — metering an API list
    // price would show money the user was never charged.
    const cents = billable ? costEurCents(model, usage, this.config.usdToEur) : 0;
    await this.db
      .update(agentRuns)
      .set({
        model,
        inputTokens: sql`${agentRuns.inputTokens} + ${usage.inputTokens}`,
        outputTokens: sql`${agentRuns.outputTokens} + ${usage.outputTokens}`,
        cacheReadTokens: sql`${agentRuns.cacheReadTokens} + ${usage.cacheReadInputTokens ?? 0}`,
        cacheWriteTokens: sql`${agentRuns.cacheWriteTokens} + ${usage.cacheCreationInputTokens ?? 0}`,
        costCents: sql`${agentRuns.costCents} + ${cents}`,
      })
      .where(eq(agentRuns.id, runId));
  }

  /** Append a log line to a run directly, for the same reason `meterRun` exists. */
  async logRun(runId: string, message: string, level: 'info' | 'warn' | 'error' = 'info'): Promise<void> {
    const safe = redactSecrets(message);
    const [{ next } = { next: 1 }] = await this.db
      .select({ next: sql<number>`coalesce(max(${runLogs.seq}), 0) + 1` })
      .from(runLogs)
      .where(eq(runLogs.runId, runId));
    await this.db.insert(runLogs).values({ runId, seq: next, level, message: safe });
    this.announce(runId);
  }

  async finish(
    runId: string,
    outcome:
      | { status: 'succeeded'; result?: Record<string, unknown> }
      | { status: 'failed'; error: string },
  ): Promise<void> {
    await this.db
      .update(agentRuns)
      .set({
        status: outcome.status,
        finishedAt: new Date(),
        error: outcome.status === 'failed' ? redactSecrets(outcome.error).slice(0, 4000) : null,
        result: outcome.status === 'succeeded' ? (outcome.result ?? null) : null,
      })
      .where(eq(agentRuns.id, runId));

    this.announce(runId, true);
  }

  async list(projectId: string, limit = 30) {
    return this.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.projectId, projectId))
      .orderBy(desc(agentRuns.createdAt))
      .limit(limit);
  }

  async get(projectId: string, runId: string) {
    const [row] = await this.db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.projectId, projectId)))
      .limit(1);
    if (!row) throw new NotFoundException('Run not found');
    return row;
  }

  async logs(runId: string): Promise<RunLogLine[]> {
    const rows = await this.db
      .select()
      .from(runLogs)
      .where(eq(runLogs.runId, runId))
      .orderBy(runLogs.seq);

    return rows.map((r) => ({
      at: r.at.toISOString(),
      level: r.level as RunLogLine['level'],
      message: r.message,
    }));
  }

  /**
   * Live log stream. Replays what has already happened, then follows — so a
   * viewer that opens late still sees the whole run.
   */
  subscribe(
    runId: string,
    onLine: (line: RunLogLine) => void,
    onEnd: (status: string) => void,
  ): () => void {
    // Each subscription tracks how far it has read and pulls forward from
    // there. Replay and follow are the same mechanism, which closes the gap
    // where a line written between "fetch the history" and "start listening"
    // reached nobody — and makes a duplicate poke harmless, since there is
    // nothing after the last sequence to deliver twice.
    let lastSeq = 0;
    let pumping = false;
    /** A poke arrived mid-read; go round once more when this one finishes. */
    let again = false;
    /** …and one of those pokes said the run had ended. */
    let endPending = false;
    let closed = false;

    const pump = async (ended: boolean): Promise<void> => {
      if (closed) return;
      if (pumping) {
        // Always re-run. Conflating "there is more to read" with "the run
        // ended" dropped every poke that arrived mid-read for a run still in
        // progress — which is most of them, and exactly the lines a viewer is
        // watching for.
        again = true;
        endPending = endPending || ended;
        return;
      }
      pumping = true;
      try {
        let wantEnd = ended;
        do {
          again = false;
          wantEnd = wantEnd || endPending;
          endPending = false;

          const rows = await this.db
            .select()
            .from(runLogs)
            .where(and(eq(runLogs.runId, runId), gt(runLogs.seq, lastSeq)))
            .orderBy(runLogs.seq);

          for (const row of rows) {
            if (closed) return;
            lastSeq = row.seq;
            onLine({
              at: row.at.toISOString(),
              level: row.level as RunLogLine['level'],
              message: row.message,
            });
          }

          if (wantEnd && !closed) {
            const [run] = await this.db
              .select({ status: agentRuns.status })
              .from(agentRuns)
              .where(eq(agentRuns.id, runId))
              .limit(1);
            // Only a terminal status is an end. The initial catch-up asks
            // with ended=true so a run that finished before anyone watched
            // still closes out — but a run that is merely queued or running
            // must keep the stream open, not end it with a status that is
            // not an ending. Announcing 'running' here closed every SSE
            // stream right after replay (the controller completes on end),
            // which sub-second dev runs masked and one loaded CI run caught.
            if (run && (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled')) {
              onEnd(run.status);
            }
          }
        } while (again);
      } finally {
        pumping = false;
      }
    };

    const handler = (ended: boolean) => void pump(ended);
    this.bus.on(runId, handler);
    // Catch up immediately: everything written before this subscription, plus
    // the terminal state if the run already finished.
    void pump(true);

    return () => {
      closed = true;
      this.bus.off(runId, handler);
    };
  }
}
