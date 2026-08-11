import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createDb, projects, users, type DbHandle } from '@specd/db';
import { ProjectsService } from './projects.service.js';

/**
 * Draft vs live projects (wizard setup state). The invariants: only the
 * wizard's explicit `draft` flag produces a draft, completion is one-way,
 * and the first completion timestamp wins.
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

describe.skipIf(!reachable)('project setup state (integration)', () => {
  let handle: DbHandle | null = null;
  let service: ProjectsService;
  let userId = '';
  const made: string[] = [];

  beforeAll(async () => {
    handle = createDb(DATABASE_URL, { max: 2 });
    service = new ProjectsService(handle.db);
    const [user] = await handle.db
      .insert(users)
      .values({ email: `setup-${Date.now()}@specd.dev`, name: 'Setup Tester', passwordHash: 'x' })
      .returning();
    userId = user!.id;
  });

  afterAll(async () => {
    if (handle) {
      if (made.length) await handle.db.delete(projects).where(inArray(projects.id, made));
      if (userId) await handle.db.delete(users).where(eq(users.id, userId));
      await handle.close();
    }
  });

  it('a plain create is live immediately — CLI and API consumers never see drafts', async () => {
    const project = await service.create({ userId, name: 'Setup Live' });
    made.push(project.id);
    expect(project.setupCompletedAt).not.toBeNull();
    expect((await service.summarize(project)).setupComplete).toBe(true);
  });

  it('a wizard draft stays incomplete until marked, and first completion wins', async () => {
    const project = await service.create({ userId, name: 'Setup Draft', draft: true });
    made.push(project.id);
    expect(project.setupCompletedAt).toBeNull();
    expect((await service.summarize(project)).setupComplete).toBe(false);

    const completed = await service.update(project.id, { setupComplete: true });
    expect(completed.setupCompletedAt).not.toBeNull();

    // Re-finishing the wizard must not move the go-live moment.
    const again = await service.update(project.id, { setupComplete: true });
    expect(again.setupCompletedAt!.getTime()).toBe(completed.setupCompletedAt!.getTime());
  });
});
