import { tmpdir } from 'node:os';
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

  readonly jwtSecret = required('JWT_SECRET');
  readonly vaultMasterKey = required('VAULT_MASTER_KEY');

  readonly anthropicApiKey = process.env.ANTHROPIC_API_KEY ?? '';
  readonly usdToEur = num('SPECD_USD_TO_EUR', 0.92);

  readonly embeddingProvider = (process.env.SPECD_EMBEDDING_PROVIDER ?? 'hash') as
    | 'hash'
    | 'voyage'
    | 'openai';
  readonly voyageApiKey = process.env.VOYAGE_API_KEY ?? '';

  /**
   * Any OpenAI-compatible `/v1/embeddings` endpoint — Ollama, LM Studio,
   * llama.cpp, vLLM, or OpenAI itself. The URL is the whole configuration:
   * pointing it at localhost is what lets a local-first install lift its
   * retrieval ceiling without sending a repository's knowledge anywhere.
   */
  readonly embeddingBaseUrl =
    process.env.SPECD_EMBEDDING_BASE_URL ?? 'http://localhost:11434/v1';
  // 1024 dimensions, because that is the width of the pgvector column. A
  // model of any other size is refused at startup rather than at insert.
  readonly embeddingModel = process.env.SPECD_EMBEDDING_MODEL ?? 'mxbai-embed-large';
  /** Empty is normal for a local server; a hosted one will need it. */
  readonly embeddingApiKey = process.env.SPECD_EMBEDDING_API_KEY ?? '';

  /**
   * Local mode writes to paths the user registered. Confining every write to a
   * configured root means a bad `localPath` cannot reach outside it.
   */
  readonly localRepoRoot = process.env.SPECD_LOCAL_REPO_ROOT || null;

  // ─── Runner job leases (S-101) ─────────────────────────────────────────────
  // A dispatched job whose runner stops heartbeating becomes claimable again
  // after the lease. Build gets its own, longer lease: a build is N model
  // calls against a real checkout, and reclaiming one that is merely slow
  // wastes far more than reclaiming a one-call spec draft. The daemon
  // heartbeats every ~30s while executing, so these are multiples of that.
  readonly runnerLeaseSeconds = num('SPECD_RUNNER_LEASE_SECONDS', 180);
  readonly runnerLeaseBuildSeconds = num('SPECD_RUNNER_LEASE_BUILD_SECONDS', 900);
  /** Reclaims allowed before the run is failed as repeatedly abandoned. */
  readonly runnerMaxReclaims = num('SPECD_RUNNER_MAX_RECLAIMS', 3);

  // ─── Webhook delivery retention (S-103) ────────────────────────────────────
  // Delivery rows are the audit trail for "why did specd do that last week",
  // kept for a window and pruned by age — the intent 0003 documented when the
  // table was created. Days, not a cron expression: subsequent prune runs pick
  // a changed value up without a code change.
  readonly webhookRetentionDays = num('SPECD_WEBHOOK_RETENTION_DAYS', 30);
  /** Prune cadence. Daily; the job also runs once at startup. */
  readonly webhookPruneIntervalMs = num('SPECD_WEBHOOK_PRUNE_INTERVAL_MS', 86_400_000);

  // ─── Index worker (0012) ───────────────────────────────────────────────────
  // Indexing left the webhook request path: a merge queues a run and a worker
  // in this process executes it, woken by Postgres LISTEN/NOTIFY.
  /** Off for a process that should serve requests but execute no index runs. */
  readonly indexWorkerEnabled = (process.env.SPECD_INDEX_WORKER_ENABLED ?? 'true') !== 'false';
  /**
   * Backstop only. NOTIFY is the primary wake-up; this covers a dropped listen
   * connection, so it is deliberately far slower than the runner's poll.
   */
  readonly indexPollMs = num('SPECD_INDEX_POLL_MS', 60_000);
  /** An index run still 'running' after this is treated as abandoned. */
  readonly indexLeaseSeconds = num('SPECD_INDEX_LEASE_SECONDS', 900);

  // ─── Onboard worker (0016) ─────────────────────────────────────────────────
  // Grounding left the request path for the reason indexing did: reading a
  // repository and then calling a model is longer than a request should stay
  // open, and while it ran inline a second click opened a second setup PR.
  /** Off for a process that should serve requests but execute no onboard runs. */
  readonly onboardWorkerEnabled = (process.env.SPECD_ONBOARD_WORKER_ENABLED ?? 'true') !== 'false';
  /** Backstop only, as with the index worker: NOTIFY is the primary wake-up. */
  readonly onboardPollMs = num('SPECD_ONBOARD_POLL_MS', 60_000);
  /**
   * An onboard run still 'running' after this is treated as abandoned. Longer
   * than the index lease, and deliberately generous: an abandoned onboard run
   * is failed rather than retried (0016), so cutting a slow-but-live run short
   * costs a person their grounding, where waiting only costs them time.
   */
  readonly onboardLeaseSeconds = num('SPECD_ONBOARD_LEASE_SECONDS', 1_800);

  // ─── GitHub App (§11) ──────────────────────────────────────────────────────
  // Absent by default: the whole product works in local mode without an App,
  // and every code path that needs one says so by name rather than failing
  // with an undefined.
  readonly githubAppId = process.env.GITHUB_APP_ID ?? '';
  readonly githubAppSlug = process.env.GITHUB_APP_SLUG ?? 'specd';
  readonly githubPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY ?? '';
  readonly githubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET ?? '';
  readonly githubApiBase = process.env.GITHUB_API_BASE ?? 'https://api.github.com';
  readonly githubBase = process.env.GITHUB_BASE ?? 'https://github.com';
  readonly githubCloneBase = process.env.GITHUB_CLONE_BASE ?? 'https://github.com';

  /**
   * Scratch root for hosted build clones. Each build gets its own directory
   * under it and deletes it afterwards — nothing here is meant to outlive a run.
   */
  readonly buildRoot = process.env.SPECD_BUILD_ROOT || tmpdir();

  get githubAppConfigured(): boolean {
    return Boolean(this.githubAppId && this.githubPrivateKey);
  }

  // ─── GitLab (§11) ──────────────────────────────────────────────────────────
  // No app-level registration exists for GitLab the way it does for GitHub —
  // each connection brings its own token and, for self-managed instances, its
  // own instance URL (stored on the connection, not here). The one thing that
  // is global is the webhook token every registered project hook is given, so
  // a single secret verifies deliveries from every tenant's GitLab instance.
  readonly gitlabWebhookSecret = process.env.GITLAB_WEBHOOK_SECRET ?? '';

  get defaultModel(): ModelId {
    const raw = process.env.SPECD_DEFAULT_MODEL;
    return raw && isModelId(raw) ? raw : DEFAULT_MODEL;
  }

  get isProd(): boolean {
    return this.nodeEnv === 'production';
  }
}
