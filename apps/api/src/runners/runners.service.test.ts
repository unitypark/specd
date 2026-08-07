import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, projects, runners, type DbHandle } from '@specd/db';
import { RunnersService } from './runners.service.js';

/**
 * Real Postgres, same convention as the gate/webhook integration tests: skip
 * quietly when nothing is reachable rather than fail the whole suite on a
 * laptop with no infra running.
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://specd:specd@localhost:5433/specd';

let handle: DbHandle | null = null;
let service: RunnersService;
let projectId = '';

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

describe.skipIf(!reachable)('RunnersService (integration)', () => {
  beforeAll(async () => {
    handle = createDb(DATABASE_URL, { max: 2 });
    service = new RunnersService(handle.db);

    const [project] = await handle.db
      .insert(projects)
      .values({ slug: `runner-test-${Date.now()}`, name: 'Runner Pairing Test' })
      .returning();
    projectId = project!.id;
  });

  afterAll(async () => {
    if (handle) {
      await handle.db.delete(projects).where(eq(projects.id, projectId));
      await handle.close();
    }
  });

  it('creates a pairing code and lists it as pending', async () => {
    const created = await service.createPairing(projectId, 'ci-runner');
    expect(created.pairCode).toMatch(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/);

    const list = await service.list(projectId);
    const row = list.find((r) => r.id === created.id);
    expect(row).toMatchObject({ name: 'ci-runner', paired: false, pending: true });
  });

  it('pairs with a valid code and returns a usable token', async () => {
    const created = await service.createPairing(projectId, 'pairs-once');
    const paired = await service.pair(created.pairCode);

    expect(paired.runnerId).toBe(created.id);
    expect(paired.projectId).toBe(projectId);
    expect(paired.token.length).toBeGreaterThan(20);

    const runner = await service.authenticate(paired.token);
    expect(runner.id).toBe(created.id);

    const list = await service.list(projectId);
    expect(list.find((r) => r.id === created.id)).toMatchObject({ paired: true, pending: false });
  });

  it('is not case-sensitive about the code, matching the CLI device flow convention', async () => {
    const created = await service.createPairing(projectId, 'lowercase-paste');
    const paired = await service.pair(created.pairCode.toLowerCase());
    expect(paired.runnerId).toBe(created.id);
  });

  it('refuses an unknown code', async () => {
    await expect(service.pair('NOPE0-00000')).rejects.toThrow(/unknown, already used, or expired/);
  });

  it('refuses a code that has already been used — single use, like a device code', async () => {
    const created = await service.createPairing(projectId, 'single-use');
    await service.pair(created.pairCode);
    await expect(service.pair(created.pairCode)).rejects.toThrow(/unknown, already used, or expired/);
  });

  it('refuses an expired code', async () => {
    const created = await service.createPairing(projectId, 'expires');
    await handle!.db
      .update(runners)
      .set({ createdAt: new Date(Date.now() - 31 * 60 * 1000) })
      .where(eq(runners.id, created.id));

    await expect(service.pair(created.pairCode)).rejects.toThrow(/unknown, already used, or expired/);
  });

  it('refuses an invalid runner token', async () => {
    await expect(service.authenticate('not-a-real-token')).rejects.toThrow(
      /invalid or revoked/i,
    );
  });

  it('bumps lastSeenAt on authenticate — the heartbeat signal', async () => {
    const created = await service.createPairing(projectId, 'heartbeat');
    const paired = await service.pair(created.pairCode);

    const before = (await handle!.db.select().from(runners).where(eq(runners.id, created.id)))[0]!
      .lastSeenAt;

    await new Promise((r) => setTimeout(r, 5));
    await service.authenticate(paired.token);

    const after = (await handle!.db.select().from(runners).where(eq(runners.id, created.id)))[0]!
      .lastSeenAt;
    expect(after!.getTime()).toBeGreaterThan(before!.getTime());
  });

  it('removes a runner scoped to its own project', async () => {
    const created = await service.createPairing(projectId, 'to-delete');
    await service.remove(projectId, created.id);

    const list = await service.list(projectId);
    expect(list.find((r) => r.id === created.id)).toBeUndefined();
  });

  it('will not remove a runner belonging to a different project', async () => {
    const created = await service.createPairing(projectId, 'protected');
    const [otherProject] = await handle!.db
      .insert(projects)
      .values({ slug: `runner-test-other-${Date.now()}`, name: 'Someone Else' })
      .returning();

    try {
      await expect(service.remove(otherProject!.id, created.id)).rejects.toThrow(/not found/i);
      const list = await service.list(projectId);
      expect(list.find((r) => r.id === created.id)).toBeDefined();
    } finally {
      await handle!.db.delete(projects).where(eq(projects.id, otherProject!.id));
    }
  });
});
