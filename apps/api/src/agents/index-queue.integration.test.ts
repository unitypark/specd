import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { agentRuns, createDb, projects, type DbHandle } from '@specd/db';
import { IndexQueueService, INDEX_QUEUE_CHANNEL } from './index-queue.service.js';
import { RunsService } from '../runs/runs.service.js';
import type { ProjectsService } from '../projects/projects.service.js';
import { Config } from '../config.js';

/**
 * The queued-index path end to end against real Postgres (0012): a run is a
 * row, LISTEN/NOTIFY only decides when the worker looks, and claiming is safe
 * for more than one worker.
 *
 * `PipelineService` is faked through the ModuleRef the worker resolves it
 * from — what is under test is the queue, not the indexing it triggers.
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://specd:specd@localhost:5433/specd';

const reachable = await (async () => {
  try {
    const probe = createDb(DATABASE_URL, { max: 1 });
    await probe.sql`SELECT 1`;
    await probe.close();
    return true;
  } catch {
    return false;
  }
})();

let handle: DbHandle | null = null;
let runs: RunsService;
let projectId = '';

/** Records what the worker asked to be indexed. */
const executed: { runId: string; projectId: string; repositoryIds?: string[] }[] = [];
let failNext = false;

const workerWith = (config: Config) =>
  new IndexQueueService(handle!, config, runs, {
    get: () => ({
      runReindex: async (input: { runId: string; projectId: string; repositoryIds?: string[] }) => {
        executed.push(input);
        if (failNext) {
          failNext = false;
          throw new Error('indexing blew up');
        }
        await handle!.db
          .update(agentRuns)
          .set({ status: 'succeeded', finishedAt: new Date() })
          .where(eq(agentRuns.id, input.runId));
        return { indexed: 1, skipped: 0, removed: 0, health: 100, runId: input.runId };
      },
    }),
  } as never);

const runRow = async (id: string) => {
  const [row] = await handle!.db.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1);
  return row ?? null;
};

describe.skipIf(!reachable)('index queue (integration)', () => {
  let config: Config;

  beforeAll(async () => {
    handle = createDb(DATABASE_URL, { max: 3 });
    process.env.DATABASE_URL ??= DATABASE_URL;
    process.env.JWT_SECRET ??= 'test';
    process.env.VAULT_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
    config = new Config();

    // ProjectsService is only reached by assertCanRun, which this path never
    // calls — an index run is not a model call and costs no tokens.
    runs = new RunsService(handle.db, handle, config, {} as ProjectsService);

    const [project] = await handle.db
      .insert(projects)
      .values({ slug: `queue-test-${Date.now()}`, name: 'Queue Test' })
      .returning();
    projectId = project!.id;
  });

  afterAll(async () => {
    if (handle) {
      await handle.db.delete(projects).where(eq(projects.id, projectId));
      await handle.close();
    }
  });

  it('delivers a NOTIFY to a listener on the same channel', async () => {
    const seen: string[] = [];
    const unlisten = await handle!.listen(INDEX_QUEUE_CHANNEL, (payload) => seen.push(payload));

    await handle!.notify(INDEX_QUEUE_CHANNEL, 'ping');
    await new Promise((r) => setTimeout(r, 150));
    await unlisten();

    expect(seen).toContain('ping');
  });

  it('claims a queued run, executes it, and leaves nothing behind', async () => {
    executed.length = 0;
    const runId = await runs.enqueue({
      projectId,
      kind: 'index',
      triggeredByName: 'test',
      jobPayload: { repositoryIds: [] },
    });
    expect((await runRow(runId))?.status).toBe('queued');

    await workerWith(config).drain();

    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({ runId, projectId, repositoryIds: [] });
    expect((await runRow(runId))?.status).toBe('succeeded');

    // Drained dry: a second pass finds nothing to do.
    executed.length = 0;
    await workerWith(config).drain();
    expect(executed).toHaveLength(0);
  });

  it('carries the repositories to index through the run row', async () => {
    executed.length = 0;
    const runId = await runs.enqueue({
      projectId,
      kind: 'index',
      jobPayload: { repositoryIds: ['repo-a', 'repo-b'] },
    });

    await workerWith(config).drain();
    expect(executed[0]).toMatchObject({ runId, repositoryIds: ['repo-a', 'repo-b'] });
  });

  it('finds the queued run a second request should fold into', async () => {
    const first = await runs.enqueue({
      projectId,
      kind: 'index',
      jobPayload: { repositoryIds: ['repo-a'] },
    });

    const pending = await runs.pendingIndexRun(projectId);
    expect(pending?.id).toBe(first);
    expect(pending?.repositoryIds).toEqual(['repo-a']);

    // Union of both scopes…
    await runs.widenIndexScope(first, ['repo-b']);
    expect((await runs.pendingIndexRun(projectId))?.repositoryIds).toEqual(['repo-a', 'repo-b']);

    // …but an empty list means "everything", so it absorbs rather than narrows.
    await runs.widenIndexScope(first, []);
    expect((await runs.pendingIndexRun(projectId))?.repositoryIds).toEqual([]);

    await workerWith(config).drain();
    expect(await runs.pendingIndexRun(projectId)).toBeNull();
  });

  it('does not offer a run that is already executing as a fold target', async () => {
    const runId = await runs.enqueue({ projectId, kind: 'index', jobPayload: { repositoryIds: [] } });
    await handle!.db
      .update(agentRuns)
      .set({ status: 'running', startedAt: new Date() })
      .where(eq(agentRuns.id, runId));

    // Past the point where a new request could join it — the caller must
    // enqueue a fresh run instead of quietly attaching to work in flight.
    expect(await runs.pendingIndexRun(projectId)).toBeNull();

    await handle!.db.delete(agentRuns).where(eq(agentRuns.id, runId));
  });

  it('reclaims a run whose executor died holding it', async () => {
    executed.length = 0;
    const runId = await runs.enqueue({ projectId, kind: 'index', jobPayload: { repositoryIds: [] } });
    // Claimed long ago by a process that never came back.
    await handle!.db
      .update(agentRuns)
      .set({ status: 'running', startedAt: new Date(Date.now() - 3_600_000) })
      .where(eq(agentRuns.id, runId));

    await workerWith(config).drain();

    expect(executed.map((e) => e.runId)).toContain(runId);
    const logs = await handle!.sql<{ message: string }[]>`
      SELECT message FROM run_logs WHERE run_id = ${runId}
    `;
    expect(logs.some((l) => /previous attempt stopped without finishing/.test(l.message))).toBe(true);
  });

  it('leaves a fresh in-flight run alone', async () => {
    executed.length = 0;
    const runId = await runs.enqueue({ projectId, kind: 'index', jobPayload: { repositoryIds: [] } });
    await handle!.db
      .update(agentRuns)
      .set({ status: 'running', startedAt: new Date() })
      .where(eq(agentRuns.id, runId));

    await workerWith(config).drain();

    expect(executed).toHaveLength(0);
    await handle!.db.delete(agentRuns).where(eq(agentRuns.id, runId));
  });

  it('never hands the same run to two workers at once', async () => {
    executed.length = 0;
    const ids = await Promise.all(
      [0, 1, 2].map(() => runs.enqueue({ projectId, kind: 'index', jobPayload: { repositoryIds: [] } })),
    );

    // FOR UPDATE SKIP LOCKED is what makes several API instances listening on
    // one channel safe rather than lucky.
    await Promise.all([workerWith(config).drain(), workerWith(config).drain()]);

    const claimed = executed.map((e) => e.runId).filter((id) => ids.includes(id));
    expect(new Set(claimed).size).toBe(claimed.length);
    expect(new Set(claimed)).toEqual(new Set(ids));
  });

  it('survives a failing run and carries on with the next', async () => {
    executed.length = 0;
    const doomed = await runs.enqueue({ projectId, kind: 'index', jobPayload: { repositoryIds: [] } });
    const next = await runs.enqueue({ projectId, kind: 'index', jobPayload: { repositoryIds: [] } });
    failNext = true;

    await expect(workerWith(config).drain()).resolves.toBeUndefined();

    expect(executed.map((e) => e.runId)).toEqual([doomed, next]);
    await handle!.db.delete(agentRuns).where(eq(agentRuns.id, doomed));
  });

  it('does nothing when the worker is switched off', async () => {
    executed.length = 0;
    const runId = await runs.enqueue({ projectId, kind: 'index', jobPayload: { repositoryIds: [] } });

    const off = Object.create(config) as Config;
    Object.defineProperty(off, 'indexWorkerEnabled', { value: false });
    const worker = workerWith(off);
    await worker.onModuleInit();
    await worker.onModuleDestroy();

    expect(executed).toHaveLength(0);
    expect((await runRow(runId))?.status).toBe('queued');
    await handle!.db.delete(agentRuns).where(eq(agentRuns.id, runId));
  });
});
