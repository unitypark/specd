import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, webhookDeliveries, type DbHandle } from '@specd/db';
import { WebhookRetentionService } from './webhook-retention.service.js';
import type { Config } from '../config.js';

/**
 * The prune job's deletion behaviour against a real Postgres: the 30-day
 * boundary, the zero-row case (must still log a count, per §10), and that a
 * query failure is logged rather than thrown.
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://specd:specd@localhost:5433/specd';

let handle: DbHandle | null = null;

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

function fakeConfig(retentionDays: number): Config {
  return { webhookRetentionDays: retentionDays, webhookPruneIntervalMs: 3600_000 } as Config;
}

async function insertDelivery(receivedAt: Date) {
  const id = randomUUID();
  await handle!.db.insert(webhookDeliveries).values({
    id,
    event: 'ping',
    outcome: 'ignored',
    receivedAt,
  });
  return id;
}

describe.skipIf(!reachable)('WebhookRetentionService (integration)', () => {
  beforeAll(() => {
    handle = createDb(DATABASE_URL, { max: 2 });
  });

  afterAll(async () => {
    if (handle) await handle.close();
  });

  it('deletes rows strictly older than the retention cutoff and keeps the rest', async () => {
    const now = Date.now();
    const oneMsPastCutoff = new Date(now - 30 * 24 * 60 * 60 * 1000 - 1);
    const exactlyAtCutoff = new Date(now - 30 * 24 * 60 * 60 * 1000);
    const withinWindow = new Date(now - 1 * 24 * 60 * 60 * 1000);

    const oldId = await insertDelivery(oneMsPastCutoff);
    const boundaryId = await insertDelivery(exactlyAtCutoff);
    const freshId = await insertDelivery(withinWindow);

    const service = new WebhookRetentionService(handle!.db, fakeConfig(30));
    await service.prune();

    const [old, boundary, fresh] = await Promise.all([
      handle!.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, oldId)),
      handle!.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, boundaryId)),
      handle!.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, freshId)),
    ]);

    expect(old).toHaveLength(0);
    expect(boundary).toHaveLength(1);
    expect(fresh).toHaveLength(1);

    await handle!.db.delete(webhookDeliveries).where(eq(webhookDeliveries.id, boundaryId));
    await handle!.db.delete(webhookDeliveries).where(eq(webhookDeliveries.id, freshId));
  });

  it('logs a count of zero rather than skipping the log entry', async () => {
    const service = new WebhookRetentionService(handle!.db, fakeConfig(30));
    const logSpy = vi.spyOn(
      (service as unknown as { logger: { log: (msg: string) => void } }).logger,
      'log',
    );

    const total = await service.prune();

    expect(total).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('pruned 0 webhook_deliveries'));

    logSpy.mockRestore();
  });

  it('logs the failure and returns without throwing when the query fails', async () => {
    const brokenDb = {
      delete: () => {
        throw new Error('connection terminated');
      },
    } as unknown as DbHandle['db'];

    const service = new WebhookRetentionService(brokenDb, fakeConfig(30));
    const errorSpy = vi.spyOn(
      (service as unknown as { logger: { error: (msg: string) => void } }).logger,
      'error',
    );

    await expect(service.prune()).resolves.toBe(0);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('connection terminated'));

    errorSpy.mockRestore();
  });
});
