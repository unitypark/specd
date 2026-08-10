import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { webhookDeliveries, type Db } from '@specd/db';
import { DB } from '../db/db.module.js';
import { Config } from '../config.js';

/** Rows deleted per statement. Each batch is its own short statement, so a
 *  large backlog never holds one long transaction across webhook inserts. */
const BATCH_SIZE = 500;

/**
 * Prunes `webhook_deliveries` by age (S-103).
 *
 * The rows are the audit trail for "why did specd do that last week" — kept
 * for a retention window and pruned by age, which is the intent
 * `packages/db/migrations/0003_github_webhooks.sql` documented when it created
 * the table. `received_at` has carried an index since that same migration, so
 * the age cutoff never table-scans.
 *
 * Runs once at startup and then daily. Startup matters: an interval alone
 * never fires in a process that restarts more often than it ticks, which is
 * every dev laptop and a daily-deploy server alike. There is no coordination
 * across API instances on purpose — deletion by age is idempotent, each row
 * is deleted by whichever instance reaches it first, and a lock would add a
 * failure mode to remove a harmless overlap.
 */
@Injectable()
export class WebhookRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookRetentionService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly config: Config,
  ) {}

  onModuleInit(): void {
    void this.prune();
    this.timer = setInterval(() => void this.prune(), this.config.webhookPruneIntervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Delete rows strictly older than the cutoff, in batches, and log the total
   * — including zero, so "the job ran and found nothing" is distinguishable
   * from "the job never ran". A failure is logged with the cause and left for
   * the next tick; it never crashes the host process.
   */
  async prune(): Promise<number> {
    const days = this.config.webhookRetentionDays;
    const cutoff = new Date(Date.now() - days * 86_400_000);
    let total = 0;

    try {
      for (;;) {
        // Strictly older: a row exactly at the cutoff is retained. The spec
        // pins that boundary, and `<` against the cutoff instant is what
        // implements it.
        const deleted = await this.db
          .delete(webhookDeliveries)
          .where(
            // ISO text with an explicit cast: the pool disables the driver's
            // type handling, so a Date parameter does not serialize — the
            // exact bug the hosted-history work hit, and the reason the
            // failure-path test below exists: this loop swallowing an error
            // looks identical to an empty table.
            sql`${webhookDeliveries.id} IN (
              SELECT id FROM webhook_deliveries
              WHERE received_at < ${cutoff.toISOString()}::timestamptz
              LIMIT ${BATCH_SIZE}
            )`,
          )
          .returning({ id: webhookDeliveries.id });

        total += deleted.length;
        if (deleted.length < BATCH_SIZE) break;
      }

      this.logger.log(`pruned ${total} webhook delivery record(s) older than ${days}d`);
      return total;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`webhook delivery prune failed (will retry next tick): ${message}`);
      return total;
    }
  }
}
