import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, projects, tickets, users, type DbHandle } from '@specd/db';
import type { SpecContent } from '@specd/shared';
import { SpecsService } from './specs.service.js';

/**
 * The gate, against a real Postgres. These are the invariants the whole
 * product rests on, so they are verified where they are actually enforced —
 * the state machine in the service *and* the CHECK constraint in the schema.
 *
 * Skipped automatically when no database is reachable, so `pnpm test` still
 * works on a laptop with nothing running.
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://specd:specd@localhost:5433/specd';

let handle: DbHandle | null = null;
let service: SpecsService;
let projectId = '';
let ticketId = '';
let userId = '';

const content: SpecContent = {
  requirements: [
    { story: 'As a user…', criteria: [{ keyword: 'WHEN', trigger: 'x', response: 'y' }] },
  ],
  design: [{ text: 'reuse the builder', citation: 'knowledge/architecture.md#contacts' }],
  tasks: [
    { id: 'T1', title: 'build it', size: 'M' },
    { id: 'T2', title: 'commit as-built spec → knowledge/specs/GATE-1-x.md', size: 'S', asBuilt: true },
  ],
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

describe.skipIf(!reachable)('the human gate (integration)', () => {
  beforeAll(async () => {
    handle = createDb(DATABASE_URL, { max: 2 });
    service = new SpecsService(handle.db);

    const stamp = Date.now();
    const [user] = await handle.db
      .insert(users)
      .values({ email: `gate-${stamp}@specd.dev`, name: 'Gate Tester', passwordHash: 'x' })
      .returning();
    userId = user!.id;

    const [project] = await handle.db
      .insert(projects)
      .values({ slug: `gate-${stamp}`, name: 'Gate Test' })
      .returning();
    projectId = project!.id;

    const [ticket] = await handle.db
      .insert(tickets)
      .values({ projectId, key: 'GATE-1', title: 'Gate test ticket' })
      .returning();
    ticketId = ticket!.id;
  });

  afterAll(async () => {
    if (handle) {
      // Cascades take the tickets, specs and runs with them.
      if (projectId) await handle.db.delete(projects).where(eq(projects.id, projectId));
      if (userId) await handle.db.delete(users).where(eq(users.id, userId));
      await handle.close();
    }
  });

  it('creates v1 as a draft', async () => {
    const spec = await service.createVersion({ projectId, ticketId, content });
    expect(spec.version).toBe(1);
    expect(spec.status).toBe('draft');
    expect(spec.approvedBy).toBeNull();
    expect(spec.citationCount).toBe(1);
  });

  it('refuses `spec pull` on a draft', async () => {
    await expect(service.pullMarkdown(projectId, 'GATE-1')).rejects.toMatchObject({
      status: 409,
    });
  });

  it('refuses to jump straight from draft to approved', async () => {
    const spec = await service.latestForTicket(ticketId);
    await expect(
      service.transition({
        projectId,
        specId: spec!.id,
        to: 'approved',
        actor: { userId, name: 'Gate Tester' },
      }),
    ).rejects.toThrow(/Cannot move a spec from "draft" to "approved"/);
  });

  it('refuses approval from a caller with no human attached', async () => {
    // This is the contract: an agent path reaching here must fail loudly.
    const spec = await service.latestForTicket(ticketId);
    await service.transition({
      projectId,
      specId: spec!.id,
      to: 'in_review',
      actor: { userId, name: 'Gate Tester' },
    });

    await expect(
      service.transition({ projectId, specId: spec!.id, to: 'approved', actor: null }),
    ).rejects.toThrow(/must be performed by a signed-in human/);
  });

  it('records who approved, at which version, and when', async () => {
    const spec = await service.latestForTicket(ticketId);
    const approved = await service.transition({
      projectId,
      specId: spec!.id,
      to: 'approved',
      actor: { userId, name: 'Gate Tester' },
    });

    expect(approved.status).toBe('approved');
    expect(approved.approvedBy).toBe('Gate Tester');
    expect(approved.approvedAt).toBeTruthy();
    expect(approved.version).toBe(1);
  });

  it('lets an approved spec through to a coding agent', async () => {
    const markdown = await service.pullMarkdown(projectId, 'GATE-1');
    expect(markdown).toContain('**WHEN** x **THE SYSTEM SHALL** y');
    expect(markdown).toContain('approved by Gate Tester');
    expect(markdown).toContain('knowledge/specs/GATE-1-x.md');
  });

  it('refuses to un-approve in place', async () => {
    const spec = await service.latestForTicket(ticketId);
    await expect(
      service.transition({
        projectId,
        specId: spec!.id,
        to: 'draft',
        actor: { userId, name: 'Gate Tester' },
      }),
    ).rejects.toThrow(/Cannot move a spec from "approved" to "draft"/);
  });

  it('supersedes rather than mutates when a v2 is drafted', async () => {
    const v1 = await service.latestForTicket(ticketId);
    const v2 = await service.createVersion({ projectId, ticketId, content });

    expect(v2.version).toBe(2);
    expect(v2.status).toBe('draft');
    expect(v2.supersedes).toBe(v1!.id);

    // v1 keeps its approval exactly as it was recorded.
    const stillV1 = await service.byId(projectId, v1!.id);
    expect(stillV1.status).toBe('approved');
    expect(stillV1.approvedBy).toBe('Gate Tester');
  });

  it('rejects an approved row with no approver at the schema level', async () => {
    // Belt and braces: even a direct write cannot record an unattributed
    // approval, because the constraint lives in the database too.
    await expect(
      handle!.sql`
        INSERT INTO specs (project_id, ticket_id, version, status, content)
        VALUES (${projectId}, ${ticketId}, 99, 'approved', ${JSON.stringify(content)}::jsonb)
      `,
    ).rejects.toThrow(/specs_approval_is_attributed/);
  });

  describe('comments on UNVERIFIED points', () => {
    it('attaches a comment to a specific design item on a draft spec', async () => {
      const v2 = await service.latestForTicket(ticketId); // v2, still draft
      const comment = await service.addComment({
        specId: v2!.id,
        specStatus: v2!.status,
        section: 'design',
        itemIndex: 0,
        authorUserId: userId,
        authorName: 'Gate Tester',
        body: 'Which builder specifically?',
      });

      expect(comment.itemIndex).toBe(0);
      expect(comment.section).toBe('design');

      const comments = await service.comments(v2!.id);
      expect(comments).toHaveLength(1);
      expect(comments[0]?.body).toBe('Which builder specifically?');
    });

    it('rejects a whitespace-only comment without persisting it', async () => {
      const v2 = await service.latestForTicket(ticketId);
      await expect(
        service.addComment({
          specId: v2!.id,
          specStatus: v2!.status,
          section: 'design',
          itemIndex: 0,
          authorUserId: userId,
          authorName: 'Gate Tester',
          body: '   \n\t  ',
        }),
      ).rejects.toThrow(/cannot be empty/);
    });

    it('refuses a new comment on the stamped, approved version', async () => {
      const v1 = await service.byId(projectId, (await service.latestForTicket(ticketId))!.supersedes!);
      expect(v1.status).toBe('approved');

      await expect(
        service.addComment({
          specId: v1.id,
          specStatus: v1.status,
          section: 'design',
          itemIndex: 0,
          authorUserId: userId,
          authorName: 'Gate Tester',
          body: 'too late now',
        }),
      ).rejects.toThrow(/comments are for clarifying a draft/);
    });
  });
});
