import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { webhookDeliveries, type Db } from '@specd/db';
import { DB } from '../db/db.module.js';
import { Config } from '../config.js';

const BATCH_SIZE = 500;

/**
 * Prunes webhook_deliveries by age (§10 — rows are the audit trail, kept
 * only for the retention window, per the intent documented in
 * packages/db/migrations/0003_github_webhooks.sql).
 *
 * Deletes in batches rather than one statement so a large backlog never
 * holds a single long-running transaction across concurrent webhook
 * inserts — each batch is its own short transaction.
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
    this.timer = setInterval(() => {
      void this.prune();
    }, this.config.webhookPruneIntervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Deletes rows strictly older than the retention cutoff, logging the
   * total count even when it is zero. Never throws — a database outage is
   * logged and left for the next scheduled run rather than crashing the
   * host process.
   */
  async prune(): Promise<number> {
    const cutoff = new Date(Date.now() - this.config.webhookRetentionDays * 24 * 60 * 60 * 1000);
    let total = 0;

    try {
      for (;;) {
        const deleted = await this.db
          .delete(webhookDeliveries)
          .where(
            sql`${webhookDeliveries.id} IN (
              SELECT id FROM webhook_deliveries
              WHERE received_at < ${cutoff}
              LIMIT ${BATCH_SIZE}
            )`,
          )
          .returning({ id: webhookDeliveries.id });

        total += deleted.length;
        if (deleted.length < BATCH_SIZE) break;
      }

      this.logger.log(
        `pruned ${total} webhook_deliveries row(s) older than ${this.config.webhookRetentionDays}d`,
      );
      return total;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`webhook_deliveries prune failed: ${message}`);
      return total;
    }
  }
}
