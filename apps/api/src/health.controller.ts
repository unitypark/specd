import { Controller, Get, Inject } from '@nestjs/common';
import type { DbHandle } from '@specd/db';
import { Public } from './auth/auth.guard.js';
import { DB_HANDLE } from './db/db.module.js';
import { Config } from './config.js';
import { EmbeddingService } from './knowledge/embeddings.js';

@Controller()
export class HealthController {
  constructor(
    @Inject(DB_HANDLE) private readonly handle: DbHandle,
    private readonly config: Config,
    private readonly embeddings: EmbeddingService,
  ) {}

  @Public()
  @Get('health')
  async health() {
    let database = 'down';
    try {
      await this.handle.sql`SELECT 1`;
      database = 'up';
    } catch {
      database = 'down';
    }

    return {
      status: database === 'up' ? 'ok' : 'degraded',
      database,
      // Stated plainly: an agent run without a key fails with a clear error
      // rather than silently doing nothing.
      ai: this.config.anthropicApiKey ? 'configured' : 'no platform key (BYO key per project)',
      embeddings: this.embeddings.name,
      defaultModel: this.config.defaultModel,
    };
  }
}
