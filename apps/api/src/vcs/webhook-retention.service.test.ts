import { Logger } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, type Db, type DbHandle } from '@specd/db';
import { WebhookRetentionService } from './webhook-retention.service.js';
import { Config } from '../config.js';

/**
 * The retention prune against real Postgres (S-103). Self-skipping when none
 * is reachable, like every suite that needs the database — and the boundary
 * cases are the point: "strictly older than the cutoff" is a one-character
 * decision (`<` vs `<=`) with a thirty-day blast radius.
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
let service: WebhookRetentionService;
let config: Config;

/** Rows this suite created, so cleanup never touches real deliveries. */
const MARK = 'retention-test';

const insertAged = async (ageDays: number, count = 1): Promise<void> => {
  await handle!.sql`
    INSERT INTO webhook_deliveries (id, provider, event, outcome, detail, received_at)
    SELECT gen_random_uuid(), 'github', 'push', 'ignored', ${MARK},
           now() - (${ageDays}::float8 * interval '1 day')
    FROM generate_series(1, ${count})
  `;
};

const remaining = async (): Promise<number> => {
  const [row] = await handle!.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM webhook_deliveries WHERE detail = ${MARK}
  `;
  return Number(row?.n ?? 0);
};

describe.skipIf(!reachable)('webhook delivery retention (integration)', () => {
  beforeAll(async () => {
    handle = createDb(DATABASE_URL, { max: 2 });
    process.env.DATABASE_URL ??= DATABASE_URL;
    process.env.JWT_SECRET ??= 'test';
    process.env.VAULT_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
    config = new Config();
    service = new WebhookRetentionService(handle.db, config);
  });

  afterAll(async () => {
    if (handle) {
      await handle.sql`DELETE FROM webhook_deliveries WHERE detail = ${MARK}`;
      await handle.close();
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await handle!.sql`DELETE FROM webhook_deliveries WHERE detail = ${MARK}`;
  });

  it('deletes strictly older rows and retains the window, including its edge', async () => {
    await insertAged(45); // well past the cutoff
    await insertAged(31); // just past
    // A hair *inside* the 30-day window. The truly instantaneous boundary is
    // untestable against a wall clock, so both sides are probed with a margin
    // the test cannot lose to scheduling: prune computes its cutoff after
    // these inserts, which only widens the gap.
    await insertAged(29.99);
    await insertAged(7);

    const deleted = await service.prune();

    expect(deleted).toBeGreaterThanOrEqual(2);
    expect(await remaining()).toBe(2);

    // The survivors are still there via an ordinary lookup — retention must
    // not change what "queryable" means inside the window.
    const rows = await handle!.sql<{ received_at: Date }[]>`
      SELECT received_at FROM webhook_deliveries WHERE detail = ${MARK} ORDER BY received_at
    `;
    expect(rows).toHaveLength(2);
  });

  it('logs a count of zero rather than skipping the log line', async () => {
    // "The job ran and found nothing" and "the job never ran" must be
    // distinguishable from the log alone — the same honesty rule the index
    // worker follows. Drain first: the shared dev database may hold genuinely
    // old rows from past dogfooding, and this test is about the zero case.
    await service.prune();
    const log = vi.spyOn(Logger.prototype, 'log');

    const deleted = await service.prune();

    expect(deleted).toBe(0);
    expect(log.mock.calls.some(([msg]) => String(msg).includes('pruned 0 webhook delivery'))).toBe(
      true,
    );
  });

  it('applies a changed retention period without a code change', async () => {
    await insertAged(15);

    const shorter = Object.create(config) as Config;
    Object.defineProperty(shorter, 'webhookRetentionDays', { value: 10 });
    const deleted = await new WebhookRetentionService(handle!.db, shorter).prune();

    expect(deleted).toBe(1);
    expect(await remaining()).toBe(0);
  });

  it('drains a backlog larger than one batch, in batches', async () => {
    // 1,200 rows against a batch size of 500: three statements, no single
    // long transaction — the WHILE requirement is about not blocking live
    // webhook inserts behind one giant delete.
    await insertAged(60, 1_200);

    const deleted = await service.prune();

    expect(deleted).toBe(1_200);
    expect(await remaining()).toBe(0);
  });

  it('logs a failure and does not crash the host process', async () => {
    const error = vi.spyOn(Logger.prototype, 'error');
    const broken = {
      delete: () => {
        throw new Error('database on fire');
      },
    } as unknown as Db;

    const failing = new WebhookRetentionService(broken, config);

    await expect(failing.prune()).resolves.toBe(0);
    expect(error.mock.calls.some(([msg]) => String(msg).includes('database on fire'))).toBe(true);
  });
});
