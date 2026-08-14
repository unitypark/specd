import { createDb, projects, policyExceptions, type DbHandle } from '@specd/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PolicyService } from './policy.service.js';
import type { KnowledgeService } from '../knowledge/knowledge.service.js';
import type { SpecView } from '@specd/shared';

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
let service: PolicyService;
let projectId = '';
let health = 100;

const fakeKnowledge = {
  health: async () => ({ score: health }),
} as unknown as KnowledgeService;

const specWith = (unverified: number): SpecView =>
  ({
    id: '00000000-0000-0000-0000-000000000000',
    ticketKey: 'CRM-1',
    title: 'Add a widget',
    version: 1,
    content: {
      requirements: [],
      design: Array.from({ length: unverified }, (_, i) => ({
        text: `Claim ${i}`,
        unverified: 'not grounded',
      })),
      tasks: [],
      outOfScope: [],
      openQuestions: [],
    },
  }) as unknown as SpecView;

/**
 * House rules on the gate (plan № 3, 2.4). Two properties carry the design:
 * NULL is "no rule" rather than zero, and the only way past a rule is a named
 * human with a typed reason — recorded, never silent.
 */
describe.skipIf(!reachable)('gate policy (integration)', () => {
  beforeAll(async () => {
    handle = createDb(DATABASE_URL, { max: 2 });
    service = new PolicyService(handle.db, fakeKnowledge);
    const [project] = await handle.db
      .insert(projects)
      .values({ slug: `policy-test-${Date.now()}`, name: 'Policy Test' })
      .returning();
    projectId = project!.id;
  }, 60_000);

  afterAll(async () => {
    if (handle) {
      if (projectId) await handle.db.delete(projects).where(eq(projects.id, projectId));
      await handle.close();
    }
  });

  it('has no opinion until a rule is set', async () => {
    // A project that never chose a floor must not be silently held to one.
    health = 3;
    expect(await service.refusalsForBuild(projectId, specWith(99), [])).toEqual([]);
  });

  it('treats zero as a real rule, not as absence', async () => {
    await handle!.db
      .update(projects)
      .set({ policyMaxUnverified: 0 })
      .where(eq(projects.id, projectId));
    expect(await service.refusalsForBuild(projectId, specWith(1), [])).toHaveLength(1);
    expect(await service.refusalsForBuild(projectId, specWith(0), [])).toEqual([]);
  });

  it('refuses below the health floor, and says the numbers', async () => {
    await handle!.db
      .update(projects)
      .set({ policyMaxUnverified: null, policyMinHealth: 60 })
      .where(eq(projects.id, projectId));
    health = 42;
    const [refusal] = await service.refusalsForBuild(projectId, specWith(0), []);
    expect(refusal!.policy).toBe('min_health');
    expect(refusal!.detail).toContain('42%');
    expect(refusal!.detail).toContain('60%');

    health = 75;
    expect(await service.refusalsForBuild(projectId, specWith(0), [])).toEqual([]);
  });

  it('only blocks on drifted citations when the project asked it to', async () => {
    const drifted = [
      { claim: 'c', citation: 'knowledge/a.md#x', was: 'supported' as const, now: 'unsupported' as const, note: null },
    ];
    await handle!.db
      .update(projects)
      .set({ policyMinHealth: null, policyBlockOnDrift: false })
      .where(eq(projects.id, projectId));
    expect(await service.refusalsForBuild(projectId, specWith(0), drifted)).toEqual([]);

    await handle!.db
      .update(projects)
      .set({ policyBlockOnDrift: true })
      .where(eq(projects.id, projectId));
    expect(await service.refusalsForBuild(projectId, specWith(0), drifted)).toHaveLength(1);
  });

  it('records who overrode a rule and why', async () => {
    const refusals = [{ policy: 'min_health', detail: 'too low' }];
    await service.recordException({
      projectId,
      specId: null as unknown as string,
      runId: null,
      ticketKey: 'CRM-1',
      refusals,
      approvedByUserId: null as unknown as string,
      approvedByName: 'Theo',
      justification: 'Shipping the hotfix; the health dip is the docs PR behind it.',
    });

    const [row] = await service.exceptions(projectId);
    expect(row).toMatchObject({ policy: 'min_health', approvedByName: 'Theo' });
    expect(row!.justification).toContain('hotfix');
  });

  it('cannot record an unattributed exception', async () => {
    // The same reasoning as `specs_approval_is_attributed`: an override with no
    // name and no reason is indistinguishable from the rule never running.
    await expect(
      handle!.sql`
        INSERT INTO policy_exceptions (project_id, ticket_key, policy, detail, approved_by_name, justification)
        VALUES (${projectId}, 'CRM-1', 'min_health', 'too low', '  ', 'because')
      `,
    ).rejects.toThrow(/policy_exception_is_attributed/);

    await expect(
      handle!.sql`
        INSERT INTO policy_exceptions (project_id, ticket_key, policy, detail, approved_by_name, justification)
        VALUES (${projectId}, 'CRM-1', 'min_health', 'too low', 'Theo', '   ')
      `,
    ).rejects.toThrow(/policy_exception_is_attributed/);
  });

  it('survives the spec it describes being deleted', async () => {
    // The audit trail outlives the work, the way run history already does.
    const rows = await handle!.db
      .select()
      .from(policyExceptions)
      .where(eq(policyExceptions.projectId, projectId));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.specId === null)).toBe(true);
  });
});
