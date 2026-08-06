import { Injectable } from '@nestjs/common';
import { DEFAULT_MODEL, isModelId, type ModelId } from '@specd/shared';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required — copy .env.example to .env`);
  return value;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

@Injectable()
export class Config {
  readonly port = num('PORT', 4000);
  readonly nodeEnv = process.env.NODE_ENV ?? 'development';
  readonly webOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
  readonly apiPublicUrl = process.env.API_PUBLIC_URL ?? `http://localhost:${num('PORT', 4000)}`;

  readonly databaseUrl = required('DATABASE_URL');
  readonly redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6380';

  readonly jwtSecret = required('JWT_SECRET');
  readonly vaultMasterKey = required('VAULT_MASTER_KEY');

  readonly anthropicApiKey = process.env.ANTHROPIC_API_KEY ?? '';
  readonly usdToEur = num('SPECD_USD_TO_EUR', 0.92);

  readonly embeddingProvider = (process.env.SPECD_EMBEDDING_PROVIDER ?? 'hash') as
    | 'hash'
    | 'voyage';
  readonly voyageApiKey = process.env.VOYAGE_API_KEY ?? '';

  /**
   * Local mode writes to paths the user registered. Confining every write to a
   * configured root means a bad `localPath` cannot reach outside it.
   */
  readonly localRepoRoot = process.env.SPECD_LOCAL_REPO_ROOT || null;

  get defaultModel(): ModelId {
    const raw = process.env.SPECD_DEFAULT_MODEL;
    return raw && isModelId(raw) ? raw : DEFAULT_MODEL;
  }

  get isProd(): boolean {
    return this.nodeEnv === 'production';
  }
}
