import { EventEmitter } from 'node:events';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { agentRuns, runLogs, type Db } from '@specd/db';
import {
  costEurCents,
  type AgentRunKind,
  type ModelId,
  type RunLogLine,
  type TokenUsage,
} from '@specd/shared';
import { DB } from '../db/db.module.js';
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
@Injectable()
export class RunsService {
  /** In-process fan-out for live SSE viewers. Persisted lines are the truth. */
  private readonly bus = new EventEmitter();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly config: Config,
    private readonly projects: ProjectsService,
  ) {
    this.bus.setMaxListeners(0);
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
      this.bus.emit(runId, line);
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
    this.bus.emit(runId, { at: new Date().toISOString(), level, message: safe });
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

    this.bus.emit(`${runId}:end`, outcome.status);
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
    const lineHandler = (line: RunLogLine) => onLine(line);
    const endHandler = (status: string) => onEnd(status);
    this.bus.on(runId, lineHandler);
    this.bus.on(`${runId}:end`, endHandler);
    return () => {
      this.bus.off(runId, lineHandler);
      this.bus.off(`${runId}:end`, endHandler);
    };
  }
}
