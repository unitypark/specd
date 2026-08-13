import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { agentRuns, createDb, projects, repositories, type DbHandle } from '@specd/db';
import { OnboardQueueService, ONBOARD_QUEUE_CHANNEL } from './onboard-queue.service.js';
import { RunsService } from '../runs/runs.service.js';
import type { ProjectsService } from '../projects/projects.service.js';
import { Config } from '../config.js';

/**
 * The queued-grounding path end to end against real Postgres (0016). Shares
 * the index queue's mechanism, so what is worth testing here is the two places
 * it deliberately differs: a run handed to a paired runner must not be claimed
 * back, and an abandoned run must be failed rather than re-executed.
 *
 * `PipelineService` is faked through the ModuleRef the worker resolves it
 * from — what is under test is the queue, not the grounding it triggers.
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
let repoId = '';
let otherRepoId = '';

/** Records what the worker asked to be grounded. */
const executed: { runId: string; projectId: string; repositoryId: string }[] = [];
let failNext = false;

const workerWith = (config: Config) =>
  new OnboardQueueService(handle!, config, runs, {
    get: () => ({
      runOnboardingRun: async (input: { runId: string; projectId: string; repositoryId: string }) => {
        executed.push(input);
        if (failNext) {
          failNext = false;
          // The real one finishes the run as failed before rethrowing.
          await handle!.db
            .update(agentRuns)
            .set({ status: 'failed', error: 'grounding blew up', finishedAt: new Date() })
            .where(eq(agentRuns.id, input.runId));
          throw new Error('grounding blew up');
        }
        await handle!.db
          .update(agentRuns)
          .set({ status: 'succeeded', finishedAt: new Date() })
          .where(eq(agentRuns.id, input.runId));
      },
    }),
  } as never);

const runRow = async (id: string) => {
  const [row] = await handle!.db.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1);
  return row ?? null;
};

const logsFor = async (id: string) =>
  handle!.sql<{ message: string }[]>`SELECT message FROM run_logs WHERE run_id = ${id}`;

const enqueueFor = (repositoryId: string) =>
  runs.enqueue({ projectId, kind: 'onboard', triggeredByName: 'test', repositoryId });

describe.skipIf(!reachable)('onboard queue (integration)', () => {
  let config: Config;

  beforeAll(async () => {
    handle = createDb(DATABASE_URL, { max: 3 });
    process.env.DATABASE_URL ??= DATABASE_URL;
    process.env.JWT_SECRET ??= 'test';
    process.env.VAULT_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
    config = new Config();

    // ProjectsService is only reached by assertCanRun, which the worker leaves
    // to PipelineService — faked here.
    runs = new RunsService(handle.db, handle, config, {} as ProjectsService);

    const [project] = await handle.db
      .insert(projects)
      .values({ slug: `onboard-queue-test-${Date.now()}`, name: 'Onboard Queue Test' })
      .returning();
    projectId = project!.id;

    const [repo, other] = await handle.db
      .insert(repositories)
      .values([
        { projectId, provider: 'local', name: 'aurora-api', isPrimary: true },
        { projectId, provider: 'local', name: 'aurora-web' },
      ])
      .returning();
    repoId = repo!.id;
    otherRepoId = other!.id;
  });

  afterAll(async () => {
    if (handle) {
      await handle.db.delete(projects).where(eq(projects.id, projectId));
      await handle.close();
    }
  });

  it('delivers a NOTIFY to a listener on the same channel', async () => {
    const seen: string[] = [];
    const unlisten = await handle!.listen(ONBOARD_QUEUE_CHANNEL, (payload) => seen.push(payload));

    await handle!.notify(ONBOARD_QUEUE_CHANNEL, 'ping');
    await new Promise((r) => setTimeout(r, 150));
    await unlisten();

    expect(seen).toContain('ping');
  });

  it('claims a queued run, executes it against its repository, and drains dry', async () => {
    executed.length = 0;
    const runId = await enqueueFor(repoId);
    expect((await runRow(runId))?.status).toBe('queued');

    await workerWith(config).drain();

    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({ runId, projectId, repositoryId: repoId });
    expect((await runRow(runId))?.status).toBe('succeeded');

    executed.length = 0;
    await workerWith(config).drain();
    expect(executed).toHaveLength(0);
  });

  it('treats a run as in flight while it is queued and while it is running', async () => {
    const runId = await enqueueFor(repoId);

    // Queued counts…
    expect((await runs.pendingOnboardRun(projectId, repoId))?.id).toBe(runId);
    // …and so does running, which is where this parts company with the index
    // queue: a second request must never open a second setup PR.
    await handle!.db
      .update(agentRuns)
      .set({ status: 'running', startedAt: new Date() })
      .where(eq(agentRuns.id, runId));
    expect((await runs.pendingOnboardRun(projectId, repoId))?.id).toBe(runId);

    // Scoped to the repository, not the project: grounding a second repo is
    // not the same work.
    expect(await runs.pendingOnboardRun(projectId, otherRepoId)).toBeNull();

    // A finished run is no longer a fold target.
    await runs.finish(runId, { status: 'succeeded' });
    expect(await runs.pendingOnboardRun(projectId, repoId)).toBeNull();
  });

  it('leaves a run dispatched to a paired runner alone', async () => {
    executed.length = 0;
    const runId = await enqueueFor(repoId);

    // What queueForRunner does: back to `queued`, but for a runner to poll for.
    // `onboard` is a dispatchable kind, so without the runner='hosted' filter
    // this worker would claim its own dispatch straight back (0005/0016).
    await runs.queueForRunner(runId, { kind: 'onboard', system: 's', user: 'u' });

    await workerWith(config).drain();

    expect(executed).toHaveLength(0);
    expect((await runRow(runId))?.status).toBe('queued');
    expect((await runRow(runId))?.runner).toBe('self_hosted');

    await handle!.db.delete(agentRuns).where(eq(agentRuns.id, runId));
  });

  it('fails an abandoned run rather than re-running it', async () => {
    executed.length = 0;
    const runId = await enqueueFor(repoId);
    // Claimed long ago by a process that never came back.
    await handle!.db
      .update(agentRuns)
      .set({ status: 'running', startedAt: new Date(Date.now() - 3_600_000) })
      .where(eq(agentRuns.id, runId));

    await workerWith(config).drain();

    // Never re-executed: it may already have opened the setup PR, and
    // propose() cannot be replayed over one that is already open.
    expect(executed).toHaveLength(0);
    const row = await runRow(runId);
    expect(row?.status).toBe('failed');
    expect(row?.error).toMatch(/stopped without finishing/);
    expect((await logsFor(runId)).some((l) => /stopped without finishing/.test(l.message))).toBe(
      true,
    );

    // …and the repository is free to be grounded again by a human.
    expect(await runs.pendingOnboardRun(projectId, repoId)).toBeNull();
  });

  it('leaves a fresh in-flight run alone', async () => {
    executed.length = 0;
    const runId = await enqueueFor(repoId);
    await handle!.db
      .update(agentRuns)
      .set({ status: 'running', startedAt: new Date() })
      .where(eq(agentRuns.id, runId));

    await workerWith(config).drain();

    expect(executed).toHaveLength(0);
    await handle!.db.delete(agentRuns).where(eq(agentRuns.id, runId));
  });

  it('fails a run that names no repository instead of crashing the drain', async () => {
    executed.length = 0;
    const runId = await runs.enqueue({ projectId, kind: 'onboard', triggeredByName: 'test' });

    await workerWith(config).drain();

    expect(executed).toHaveLength(0);
    expect((await runRow(runId))?.status).toBe('failed');
    expect((await runRow(runId))?.error).toMatch(/names no repository/);
  });

  it('never hands the same run to two workers at once', async () => {
    executed.length = 0;
    const ids = await Promise.all([
      enqueueFor(repoId),
      enqueueFor(otherRepoId),
      enqueueFor(repoId),
    ]);

    // FOR UPDATE SKIP LOCKED is what makes several API instances listening on
    // one channel safe rather than lucky.
    await Promise.all([workerWith(config).drain(), workerWith(config).drain()]);

    const claimed = executed.map((e) => e.runId).filter((id) => ids.includes(id));
    expect(new Set(claimed).size).toBe(claimed.length);
    expect(new Set(claimed)).toEqual(new Set(ids));
  });

  it('survives a failing run and carries on with the next', async () => {
    executed.length = 0;
    const doomed = await enqueueFor(repoId);
    const next = await enqueueFor(otherRepoId);
    failNext = true;

    await expect(workerWith(config).drain()).resolves.toBeUndefined();

    expect(executed.map((e) => e.runId)).toEqual([doomed, next]);
    await handle!.db.delete(agentRuns).where(eq(agentRuns.id, doomed));
  });

  it('does nothing when the worker is switched off', async () => {
    executed.length = 0;
    const runId = await enqueueFor(repoId);

    const off = Object.create(config) as Config;
    Object.defineProperty(off, 'onboardWorkerEnabled', { value: false });
    const worker = workerWith(off);
    await worker.onModuleInit();
    await worker.onModuleDestroy();

    expect(executed).toHaveLength(0);
    expect((await runRow(runId))?.status).toBe('queued');
    await handle!.db.delete(agentRuns).where(eq(agentRuns.id, runId));
  });
});
