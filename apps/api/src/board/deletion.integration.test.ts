import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  agentRuns,
  createDb,
  projects,
  specs,
  tickets,
  users,
  webhookDeliveries,
  type DbHandle,
} from '@specd/db';
import type { SpecContent } from '@specd/shared';
import { ProjectsService } from '../projects/projects.service.js';
import { BoardService } from './board.service.js';

/**
 * Deletion, against a real Postgres — because everything interesting about
 * deleting here IS the database: which children cascade, which survive with
 * a nulled reference, and which states refuse the delete outright.
 *
 * Skipped automatically when no database is reachable, so `pnpm test` still
 * works on a laptop with nothing running.
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://specd:specd@localhost:5433/specd';

const content: SpecContent = {
  requirements: [
    { story: 'As a user…', criteria: [{ keyword: 'WHEN', trigger: 'x', response: 'y' }] },
  ],
  design: [{ text: 'reuse the builder', citation: 'knowledge/architecture.md#contacts' }],
  tasks: [{ id: 'T1', title: 'build it', size: 'M' }],
};

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

describe.skipIf(!reachable)('deletion (integration)', () => {
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

  async function makeTicket(projectId: string, key: string) {
    const [ticket] = await handle!.db
      .insert(tickets)
      .values({ projectId, key, title: `Deletion test ${key}` })
      .returning();
    return ticket!;
  }

  beforeAll(async () => {
    handle = createDb(DATABASE_URL, { max: 2 });
    projectsService = new ProjectsService(handle.db);
    board = new BoardService(handle.db);

    const [user] = await handle.db
      .insert(users)
      .values({ email: `deletion-${Date.now()}@specd.dev`, name: 'Deletion Tester', passwordHash: 'x' })
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

  it('deletes a ticket and its draft spec with it', async () => {
    const project = await makeProject('Del Draft');
    const ticket = await makeTicket(project.id, 'DEL-1');
    const [draft] = await handle!.db
      .insert(specs)
      .values({ projectId: project.id, ticketId: ticket.id, version: 1, status: 'draft', content })
      .returning();

    await board.removeTicket(project.id, ticket.id);

    const remaining = await handle!.db.select().from(tickets).where(eq(tickets.id, ticket.id));
    expect(remaining).toHaveLength(0);
    const orphans = await handle!.db.select().from(specs).where(eq(specs.id, draft!.id));
    expect(orphans).toHaveLength(0);
  });

  it('refuses to delete a ticket whose spec reached the gate, naming the status', async () => {
    const project = await makeProject('Del Gated');
    const ticket = await makeTicket(project.id, 'DEL-2');
    await handle!.db.insert(specs).values({
      projectId: project.id,
      ticketId: ticket.id,
      version: 1,
      status: 'approved',
      content,
      approvedByUserId: userId,
      approvedByName: 'Deletion Tester',
      approvedAt: new Date(),
    });

    await expect(board.removeTicket(project.id, ticket.id)).rejects.toMatchObject({
      status: 409,
      response: { error: 'ticket_has_delivered_work', specStatus: 'approved' },
    });
    expect(await board.get(project.id, ticket.id)).toBeTruthy();
  });

  it('refuses to delete a ticket while a run on it is executing, then allows it after', async () => {
    const project = await makeProject('Del Busy Ticket');
    const ticket = await makeTicket(project.id, 'DEL-3');
    const [run] = await handle!.db
      .insert(agentRuns)
      .values({ projectId: project.id, ticketId: ticket.id, kind: 'spec', status: 'running' })
      .returning();

    await expect(board.removeTicket(project.id, ticket.id)).rejects.toMatchObject({
      status: 409,
      response: { error: 'runs_in_flight' },
    });

    await handle!.db
      .update(agentRuns)
      .set({ status: 'succeeded' })
      .where(eq(agentRuns.id, run!.id));
    await board.removeTicket(project.id, ticket.id);

    // The run outlives its ticket — history is not collateral damage.
    const [survivor] = await handle!.db.select().from(agentRuns).where(eq(agentRuns.id, run!.id));
    expect(survivor).toBeTruthy();
    expect(survivor!.ticketId).toBeNull();
  });

  it('deletes a project with everything under it, but webhook deliveries survive unowned', async () => {
    const project = await makeProject('Del Total');
    const ticket = await makeTicket(project.id, 'DEL-4');
    const deliveryId = randomUUID();
    await handle!.db.insert(webhookDeliveries).values({
      id: deliveryId,
      event: 'push',
      outcome: 'reindex',
      projectId: project.id,
    });

    await projectsService.remove(project.id);

    expect(await handle!.db.select().from(projects).where(eq(projects.id, project.id))).toHaveLength(0);
    expect(await handle!.db.select().from(tickets).where(eq(tickets.id, ticket.id))).toHaveLength(0);
    const [delivery] = await handle!.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, deliveryId));
    expect(delivery).toBeTruthy();
    expect(delivery!.projectId).toBeNull();
    await handle!.db.delete(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId));
  });

  it('refuses to delete a project while a run is executing; a queued run does not block', async () => {
    const project = await makeProject('Del Busy Project');
    const [run] = await handle!.db
      .insert(agentRuns)
      .values({ projectId: project.id, kind: 'index', status: 'running' })
      .returning();

    await expect(projectsService.remove(project.id)).rejects.toMatchObject({
      status: 409,
      response: { error: 'runs_in_flight', runningCount: 1 },
    });

    // A queued row never started; it dies with the project instead of blocking.
    await handle!.db.update(agentRuns).set({ status: 'queued' }).where(eq(agentRuns.id, run!.id));
    await projectsService.remove(project.id);
    expect(await handle!.db.select().from(projects).where(eq(projects.id, project.id))).toHaveLength(0);
  });
});
