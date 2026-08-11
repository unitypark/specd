import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, projects, type DbHandle } from '@specd/db';
import { RunsService } from './runs.service.js';
import type { ProjectsService } from '../projects/projects.service.js';
import { Config } from '../config.js';
import type { RunLogLine } from '@specd/shared';

/**
 * Run-log streaming across two API processes.
 *
 * Two `RunsService` instances on separate connections stand in for two
 * instances of the API. Before this, the fan-out was a per-process
 * `EventEmitter`: a viewer attached to one saw nothing from a run executing on
 * the other, silently, and only once someone ran more than one — which is the
 * worst time to discover it.
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

let a: DbHandle | null = null;
let b: DbHandle | null = null;
let onA: RunsService;
let onB: RunsService;
let projectId = '';

/** Wait for a condition the other instance has to deliver, or give up. */
const until = async (predicate: () => boolean, ms = 3_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe.skipIf(!reachable)('run log streaming (integration)', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL ??= DATABASE_URL;
    process.env.JWT_SECRET ??= 'test';
    process.env.VAULT_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
    const config = new Config();

    a = createDb(DATABASE_URL, { max: 2 });
    b = createDb(DATABASE_URL, { max: 2 });
    onA = new RunsService(a.db, a, config, {} as ProjectsService);
    onB = new RunsService(b.db, b, config, {} as ProjectsService);
    await onA.onModuleInit();
    await onB.onModuleInit();

    const [project] = await a.db
      .insert(projects)
      .values({ slug: `stream-test-${Date.now()}`, name: 'Stream Test' })
      .returning();
    projectId = project!.id;
  });

  afterAll(async () => {
    await onA?.onModuleDestroy();
    await onB?.onModuleDestroy();
    if (a) {
      await a.db.delete(projects).where(eq(projects.id, projectId));
      await a.close();
    }
    await b?.close();
  });

  it('delivers a line written on one instance to a viewer on the other', async () => {
    const run = await onB.start({ projectId, kind: 'index' });
    const seen: RunLogLine[] = [];
    const stop = onA.subscribe(
      run.id,
      (line) => seen.push(line),
      () => {},
    );

    await run.log('written on the other instance');
    await until(() => seen.some((l) => l.message.includes('other instance')));
    stop();

    expect(seen.map((l) => l.message)).toContain('written on the other instance');
  });

  it('replays what was written before the viewer arrived', async () => {
    const run = await onB.start({ projectId, kind: 'index' });
    await run.log('first');
    await run.log('second');

    const seen: RunLogLine[] = [];
    const stop = onA.subscribe(
      run.id,
      (line) => seen.push(line),
      () => {},
    );
    await until(() => seen.length >= 2);
    stop();

    // Replay and follow are one mechanism now, so history arrives in order and
    // nothing written between "read the history" and "start listening" is lost.
    expect(seen.map((l) => l.message)).toEqual(['first', 'second']);
  });

  it('delivers each line once even though both paths fire', async () => {
    // The local emitter and the Postgres channel both poke the same
    // sequence-based read, so a doubled poke has nothing left to deliver.
    const run = await onB.start({ projectId, kind: 'index' });
    const seen: RunLogLine[] = [];
    const stop = onB.subscribe(
      run.id,
      (line) => seen.push(line),
      () => {},
    );

    await run.log('only once');
    await until(() => seen.length >= 1);
    await new Promise((r) => setTimeout(r, 200));
    stop();

    expect(seen.filter((l) => l.message === 'only once')).toHaveLength(1);
  });

  it('tells a viewer on the other instance that the run ended', async () => {
    const run = await onB.start({ projectId, kind: 'index' });
    let ended: string | null = null;
    const stop = onA.subscribe(
      run.id,
      () => {},
      (status) => {
        ended = status;
      },
    );

    await onB.finish(run.id, { status: 'succeeded' });
    await until(() => ended !== null);
    stop();

    expect(ended).toBe('succeeded');
  });

  it('never announces an end for a run that is still running', async () => {
    // The regression this suite flaked on: the initial catch-up read the
    // run's status and reported it as an end WHATEVER it was — so every
    // fresh subscription to a live run fired onEnd('running') and the SSE
    // layer closed the stream right after replay. The flake was the finish
    // racing that false end; the bug was the false end itself.
    const run = await onB.start({ projectId, kind: 'index' });
    await run.log('still going');
    let ended: string | null = null;
    const stop = onA.subscribe(
      run.id,
      () => {},
      (status) => {
        ended = status;
      },
    );

    // Give the initial catch-up pump ample time to run its end-check.
    await new Promise((r) => setTimeout(r, 300));
    expect(ended).toBeNull();

    await onB.finish(run.id, { status: 'succeeded' });
    await until(() => ended !== null);
    stop();

    expect(ended).toBe('succeeded');
  });

  it('closes out a run that had already finished before anyone watched', async () => {
    const run = await onB.start({ projectId, kind: 'index' });
    await run.log('all over');
    await onB.finish(run.id, { status: 'failed', error: 'nope' });

    const seen: string[] = [];
    let ended: string | null = null;
    const stop = onA.subscribe(
      run.id,
      (line) => seen.push(line.message),
      (status) => {
        ended = status;
      },
    );
    await until(() => ended !== null);
    stop();

    expect(seen).toContain('all over');
    expect(ended).toBe('failed');
  });
});
