import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, projects, tickets, users, type DbHandle } from '@specd/db';
import { ProjectsService } from '../projects/projects.service.js';
import { BoardService } from './board.service.js';

/**
 * Ranking a lane, against a real Postgres — because the whole point of
 * `position` is what the *next* read returns, and an in-memory fake would only
 * ever confirm that the arithmetic in this file matches itself.
 *
 * Skipped automatically when no database is reachable, so `pnpm test` still
 * works on a laptop with nothing running.
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

describe.skipIf(!reachable)('board ranking (integration)', () => {
  let handle: DbHandle | null = null;
  let projectsService: ProjectsService;
  let board: BoardService;
  let userId = '';
  const madeProjects: string[] = [];

  async function makeProject(name: string) {
    const project = await projectsService.create({ userId, name });
    madeProjects.push(project.id);
    return project;
  }

  /** Three backlog tickets, created in order. */
  async function makeLane(projectId: string) {
    const a = await board.createTicket({ projectId, keyPrefix: 'RNK', title: 'first' });
    const b = await board.createTicket({ projectId, keyPrefix: 'RNK', title: 'second' });
    const c = await board.createTicket({ projectId, keyPrefix: 'RNK', title: 'third' });
    return { a, b, c };
  }

  const backlogTitles = async (projectId: string) =>
    (await board.cards(projectId)).filter((c) => c.columnKey === 'backlog').map((c) => c.title);

  beforeAll(async () => {
    handle = createDb(DATABASE_URL, { max: 2 });
    projectsService = new ProjectsService(handle.db);
    board = new BoardService(handle.db);

    const [user] = await handle.db
      .insert(users)
      .values({ email: `rank-${Date.now()}@specd.dev`, name: 'Rank Tester', passwordHash: 'x' })
      .returning();
    userId = user!.id;
  });

  afterAll(async () => {
    if (handle) {
      for (const id of madeProjects) {
        await handle.db.delete(projects).where(eq(projects.id, id));
      }
      if (userId) await handle.db.delete(users).where(eq(users.id, userId));
      await handle.close();
    }
  });

  it('adds new tickets to the bottom of the backlog', async () => {
    const project = await makeProject('Rank Append');
    await makeLane(project.id);
    // A brand-new ticket is unprioritised, so it queues behind whatever the
    // team has already ranked rather than landing on top of it.
    expect(await backlogTitles(project.id)).toEqual(['first', 'second', 'third']);
  });

  it('ranks a lane in the order it is given, and reads back that way', async () => {
    const project = await makeProject('Rank Order');
    const { a, b, c } = await makeLane(project.id);

    await board.reorder(project.id, 'backlog', [c.id, a.id, b.id]);

    expect(await backlogTitles(project.id)).toEqual(['third', 'first', 'second']);
  });

  it('keeps tickets it was not told about, behind the ones it was', async () => {
    // The race this exists for: someone else adds a ticket between this
    // client's last load and its drop. Refusing the drag because a colleague
    // was typing is worse than putting the newcomer one row lower.
    const project = await makeProject('Rank Race');
    const { a, b, c } = await makeLane(project.id);
    const late = await board.createTicket({ projectId: project.id, keyPrefix: 'RNK', title: 'late' });

    await board.reorder(project.id, 'backlog', [c.id, b.id, a.id]);

    expect(await backlogTitles(project.id)).toEqual(['third', 'second', 'first', 'late']);
    expect(late.id).toBeTruthy();
  });

  it('ignores ids from another lane instead of dragging them into this one', async () => {
    const project = await makeProject('Rank Scope');
    const { a, b, c } = await makeLane(project.id);
    await board.update(project.id, c.id, { columnKey: 'draft' });

    await board.reorder(project.id, 'backlog', [c.id, b.id, a.id]);

    expect(await backlogTitles(project.id)).toEqual(['second', 'first']);
    const moved = await board.get(project.id, c.id);
    expect(moved.columnKey).toBe('draft');
  });

  it('does not count reprioritising as the work having moved', async () => {
    // The board reads `updatedAt` as age. Bumping it here would make every
    // reprioritised card look freshly worked on — exactly the lie the age
    // marker exists to catch.
    const project = await makeProject('Rank Age');
    const { a, b, c } = await makeLane(project.id);
    const before = (await board.get(project.id, a.id)).updatedAt;

    await board.reorder(project.id, 'backlog', [c.id, b.id, a.id]);

    expect((await board.get(project.id, a.id)).updatedAt).toEqual(before);
  });

  it('does nothing at all when the lane is empty', async () => {
    const project = await makeProject('Rank Empty');
    await expect(board.reorder(project.id, 'building', [])).resolves.toBeUndefined();
  });
});
