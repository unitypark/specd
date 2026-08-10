import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { migrate } from './migrate.js';

/**
 * Migrations applied from zero, against a throwaway database.
 *
 * This is the path a real deployment takes and the one that never happens
 * locally: a developer's database grows one migration at a time as they are
 * written, so a migration that only works when the previous state happened to
 * be there would pass unnoticed forever. Same self-skipping convention as the
 * API's integration suites.
 */

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://specd:specd@localhost:5433/specd';
const TEST_DB = `specd_migrate_test_${process.pid}`;
const testUrl = new URL(ADMIN_URL);
testUrl.pathname = `/${TEST_DB}`;

const reachable = await (async () => {
  try {
    const probe = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
    await probe`SELECT 1`;
    await probe.end({ timeout: 5 });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!reachable)('migrations (integration)', () => {
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
    await admin.end({ timeout: 5 });
    sql = postgres(testUrl.toString(), { max: 2, onnotice: () => {} });
  }, 60_000);

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
    const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB}`).catch(() => undefined);
    await admin.end({ timeout: 5 });
  }, 60_000);

  it('applies every migration to an empty database', async () => {
    const { applied } = await migrate(testUrl.toString());

    expect(applied.length).toBeGreaterThan(0);
    // Filename order is the contract — 0002 cannot run before 0001.
    expect([...applied].sort()).toEqual(applied);
    expect(applied[0]).toMatch(/^0001_/);
  }, 120_000);

  it('is idempotent — a second run applies nothing', async () => {
    const { applied } = await migrate(testUrl.toString());
    expect(applied).toEqual([]);
  }, 60_000);

  it('creates the extensions the schema depends on', async () => {
    // pgvector for the knowledge index, pg_trgm for the text half of the
    // hybrid retrieval. A missing extension fails far away from here.
    const rows = await sql<{ extname: string }[]>`
      SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pg_trgm')
    `;
    expect(rows.map((r) => r.extname).sort()).toEqual(['pg_trgm', 'vector']);
  });

  it('creates every table the application reads', async () => {
    const rows = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
    `;
    const tables = new Set(rows.map((r) => r.table_name));

    for (const table of [
      'users',
      'projects',
      'memberships',
      'connections',
      'repositories',
      'tickets',
      'specs',
      'spec_comments',
      'runners',
      'agent_runs',
      'run_logs',
      'knowledge_docs',
      'knowledge_chunks',
      'knowledge_health',
      'device_codes',
      'webhook_deliveries',
    ]) {
      expect(tables, `missing table ${table}`).toContain(table);
    }
  });

  it('keeps the approval invariant in the database, not only in the service', async () => {
    // Real rows first, so this cannot pass on a foreign-key violation and be
    // mistaken for the constraint under test.
    const [project] = await sql<{ id: string }[]>`
      INSERT INTO projects (slug, name) VALUES ('check-test', 'Check Test') RETURNING id
    `;
    const [ticket] = await sql<{ id: string }[]>`
      INSERT INTO tickets (project_id, key, title)
      VALUES (${project!.id}, 'CT-1', 'Check test ticket') RETURNING id
    `;

    // A draft with no approver is fine — that is the normal case.
    await sql`
      INSERT INTO specs (project_id, ticket_id, version, status, content)
      VALUES (${project!.id}, ${ticket!.id}, 1, 'draft', '{}'::jsonb)
    `;

    // The same row claiming approval, with nobody attached, must be refused —
    // the gate is the product, so it is a CHECK constraint and not only a
    // service rule. A direct write cannot record an unattributed approval.
    const err = await sql`
      INSERT INTO specs (project_id, ticket_id, version, status, content)
      VALUES (${project!.id}, ${ticket!.id}, 2, 'approved', '{}'::jsonb)
    `.catch((e: unknown) => e as { code?: string; constraint_name?: string });

    expect(err).toBeInstanceOf(Error);
    // 23514 = check_violation. Anything else (a FK, a not-null) would mean
    // this test is watching the wrong failure.
    expect((err as { code?: string }).code).toBe('23514');

    // And it succeeds the moment a named approver is present.
    await sql`
      INSERT INTO specs (project_id, ticket_id, version, status, content, approved_by_name, approved_at)
      VALUES (${project!.id}, ${ticket!.id}, 3, 'approved', '{}'::jsonb, 'Theo', now())
    `;
  });

  it('indexes the queued-job lookup the runner claim depends on', async () => {
    const rows = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'agent_runs'
    `;
    expect(rows.map((r) => r.indexname)).toContain('agent_runs_queued_idx');
  });
});
