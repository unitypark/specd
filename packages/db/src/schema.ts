import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { SpecContent } from '@specd/shared';

/**
 * The spine (§10):
 *
 *   User ─< Membership >─ Project ─┬─< Repository
 *                                  ├─< Connection      (vcs | ai | tracker)
 *                                  ├── Board ──< Ticket ──< Spec
 *                                  ├─< AgentRun
 *                                  ├─< KnowledgeDoc ──< KnowledgeChunk
 *                                  └─< Runner
 *
 * Note what is NOT here: repository contents. Git is the only source of truth
 * for knowledge (D4); the platform stores a derived index and nothing else.
 * Delete your project and we hold nothing you would miss.
 */

/** Embedding width. Fixed because pgvector indexes are dimension-bound — see
 *  `packages/db/README.md` before changing it (requires a re-index). */
export const EMBEDDING_DIM = 1024;

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_key').on(sql`lower(${t.email})`)],
);

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /** Spend caps are default-on (§12). Enforced pre-run, per project, per month. */
    spendCapCents: integer('spend_cap_cents').notNull().default(10_000),
    defaultModel: text('default_model').notNull().default('claude-opus-5'),
    /** Kill switch per project (§12). */
    agentsPaused: boolean('agents_paused').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('projects_slug_key').on(t.slug)],
);

export const memberships = pgTable(
  'memberships',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('reviewer'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.projectId] }),
    index('memberships_project_idx').on(t.projectId),
  ],
);

export const connections = pgTable(
  'connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** vcs | ai | tracker */
    kind: text('kind').notNull(),
    /** local | github | gitlab | anthropic | jira | board */
    provider: text('provider').notNull(),
    label: text('label'),
    /** Non-secret settings: instance URL, model, org, Jira project key… */
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    /**
     * Envelope-encrypted credential blob. Decrypted only inside the run that
     * needs it and never logged (§12). Null for connections with no secret
     * (built-in board, local git, subscription-via-runner).
     */
    encryptedSecret: text('encrypted_secret'),
    status: text('status').notNull().default('connected'),
    lastValidatedAt: timestamp('last_validated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('connections_project_kind_idx').on(t.projectId, t.kind)],
);

export const repositories = pgTable(
  'repositories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    connectionId: uuid('connection_id').references(() => connections.id, { onDelete: 'set null' }),
    provider: text('provider').notNull(),
    /** Provider-side id (GitHub repo id, GitLab project id) — null in local mode. */
    externalId: text('external_id'),
    name: text('name').notNull(),
    /** Absolute path, local mode only. Validated against SPECD_LOCAL_REPO_ROOT. */
    localPath: text('local_path'),
    defaultBranch: text('default_branch').notNull().default('main'),
    /** Cross-repo specs live once, and the as-built file lands here (D8). */
    isPrimary: boolean('is_primary').notNull().default(false),
    stack: jsonb('stack').$type<Record<string, unknown>>(),
    setupBranch: text('setup_branch'),
    setupPrUrl: text('setup_pr_url'),
    /** pending → open → merged. Adoption = merge (§6 step 6). */
    setupState: text('setup_state').notNull().default('pending'),
    kbStatus: text('kb_status').notNull().default('none'),
    /** none | registered | failed — GitLab webhooks are per-repo API calls, not
     *  a one-time App setup, so registering one can fail (§11) and the UI needs
     *  to say so rather than silently missing every future merge. */
    webhookStatus: text('webhook_status').notNull().default('none'),
    lastIndexedAt: timestamp('last_indexed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('repositories_project_idx').on(t.projectId),
    uniqueIndex('repositories_project_name_key').on(t.projectId, t.name),
  ],
);

export const tickets = pgTable(
  'tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Human-facing key: CRM-142. */
    key: text('key').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    /** native | jira */
    source: text('source').notNull().default('native'),
    externalKey: text('external_key'),
    externalUrl: text('external_url'),
    columnKey: text('column_key').notNull().default('backlog'),
    position: integer('position').notNull().default(0),
    assignee: text('assignee'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('tickets_project_key_key').on(t.projectId, t.key),
    index('tickets_project_column_idx').on(t.projectId, t.columnKey),
  ],
);

/**
 * Specs are append-only: v2 supersedes v1 with the review discussion as input,
 * and `approvedBy`/`approvedAt` pin the audit story (§10). Ticket ↔ spec is
 * 1:1 per version — a ticket big enough for two specs is two tickets.
 */
export const specs = pgTable(
  'specs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    status: text('status').notNull().default('draft'),
    content: jsonb('content').$type<SpecContent>().notNull(),
    citationCount: integer('citation_count').notNull().default(0),
    unverifiedCount: integer('unverified_count').notNull().default(0),
    /** Recorded human act. Never written by an agent path (§8 stage 4). */
    approvedByUserId: uuid('approved_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    approvedByName: text('approved_by_name'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    supersedesId: uuid('supersedes_id'),
    createdByRunId: uuid('created_by_run_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('specs_ticket_version_key').on(t.ticketId, t.version),
    index('specs_project_status_idx').on(t.projectId, t.status),
  ],
);

export const specComments = pgTable(
  'spec_comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    specId: uuid('spec_id')
      .notNull()
      .references(() => specs.id, { onDelete: 'cascade' }),
    /** requirements | design | tasks */
    section: text('section').notNull(),
    authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    authorName: text('author_name').notNull(),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('spec_comments_spec_idx').on(t.specId)],
);

export const runners = pgTable(
  'runners',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Short pairing code shown in the wizard: XK4-9TR. */
    pairCode: text('pair_code').notNull(),
    pairedAt: timestamp('paired_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    tokenHash: text('token_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('runners_pair_code_key').on(t.pairCode)],
);

/** Every agent interaction is an immutable, auditable record (§12). */
export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** onboard | spec | index | build */
    kind: text('kind').notNull(),
    /** hosted | self_hosted */
    runner: text('runner').notNull().default('hosted'),
    model: text('model'),
    /** queued | running | succeeded | failed | cancelled */
    status: text('status').notNull().default('queued'),
    triggeredByUserId: uuid('triggered_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    triggeredByName: text('triggered_by_name'),
    ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
    repositoryId: uuid('repository_id').references(() => repositories.id, { onDelete: 'set null' }),
    /**
     * The runner that claimed this job — null until claimed, and always null
     * for a `hosted` run. Set atomically by the claim query, never by a
     * separate write, so two runners racing for the same queued job cannot
     * both win (§ runner job dispatch).
     */
    runnerId: uuid('runner_id').references(() => runners.id, { onDelete: 'set null' }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    /**
     * Everything a runner needs to execute a queued job, and everything the
     * server needs to finish it once the runner reports back — assembled
     * server-side (knowledge retrieval, prompt construction) before the run
     * is ever queued, since a runner has no database access of its own.
     * Cleared once the run finishes; nothing here outlives the run it belongs to.
     */
    jobPayload: jsonb('job_payload').$type<Record<string, unknown>>(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    costCents: integer('cost_cents').notNull().default(0),
    error: text('error'),
    result: jsonb('result').$type<Record<string, unknown>>(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('agent_runs_project_created_idx').on(t.projectId, t.createdAt),
    index('agent_runs_project_status_idx').on(t.projectId, t.status),
    index('agent_runs_queued_idx').on(t.projectId, t.status, t.runnerId),
  ],
);

/** Log lines, persisted so the SSE viewer can replay a run from the start. */
export const runLogs = pgTable(
  'run_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    level: text('level').notNull().default('info'),
    message: text('message').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('run_logs_run_seq_key').on(t.runId, t.seq)],
);

export const knowledgeDocs = pgTable(
  'knowledge_docs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    /** doc | adr | runbook | spec */
    kind: text('kind').notNull().default('doc'),
    title: text('title'),
    /** Content sha — a doc whose sha is unchanged is not re-embedded. */
    sha: text('sha').notNull(),
    content: text('content').notNull(),
    /** Last time the file itself changed in git, not when we indexed it. */
    docUpdatedAt: timestamp('doc_updated_at', { withTimezone: true }),
    indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
    /** True while the file still carries generated UNVERIFIED markers. */
    hasUnverified: boolean('has_unverified').notNull().default(false),
    isStub: boolean('is_stub').notNull().default(false),
  },
  (t) => [
    uniqueIndex('knowledge_docs_repo_path_key').on(t.repositoryId, t.path),
    index('knowledge_docs_project_idx').on(t.projectId),
  ],
);

/**
 * Hybrid retrieval: a dense vector plus a Postgres tsvector. With the default
 * local hash embedder the lexical side carries quality; swapping in real
 * embeddings lifts the dense side without touching the query path.
 */
export const knowledgeChunks = pgTable(
  'knowledge_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    docId: uuid('doc_id')
      .notNull()
      .references(() => knowledgeDocs.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    ord: integer('ord').notNull(),
    heading: text('heading'),
    text: text('text').notNull(),
    tokens: integer('tokens').notNull().default(0),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIM }),
  },
  (t) => [
    index('knowledge_chunks_doc_idx').on(t.docId),
    index('knowledge_chunks_project_idx').on(t.projectId),
  ],
);

/**
 * CLI device-code flow (§9): the browser confirms, a short-lived
 * project-scoped token lands in the OS keychain. No passwords on disk.
 */
export const deviceCodes = pgTable(
  'device_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceCode: text('device_code').notNull(),
    userCode: text('user_code').notNull(),
    status: text('status').notNull().default('pending'),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    issuedToken: text('issued_token'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('device_codes_device_code_key').on(t.deviceCode),
    uniqueIndex('device_codes_user_code_key').on(t.userCode),
  ],
);

/** Freshness/health snapshot, recomputed on every index run. */
export const knowledgeHealth = pgTable('knowledge_health', {
  projectId: uuid('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  score: real('score').notNull().default(0),
  docCount: integer('doc_count').notNull().default(0),
  staleCount: integer('stale_count').notNull().default(0),
  stubCount: integer('stub_count').notNull().default(0),
  asBuiltCount: integer('as_built_count').notNull().default(0),
  notes: jsonb('notes').$type<{ icon: string; text: string }[]>().notNull().default([]),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Every webhook delivery we accepted, keyed by the id GitHub assigned it.
 *
 * The primary key is the deduplication: GitHub retries, and someone hitting
 * "Redeliver" in the Advanced tab must not re-run an index or re-log a merge.
 * It doubles as the answer to "why did specd move that spec at 03:00" (§10).
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    /** X-GitHub-Delivery. Deliberately not defaulted — it comes from GitHub. */
    id: uuid('id').primaryKey(),
    provider: text('provider').notNull().default('github'),
    event: text('event').notNull(),
    action: text('action'),
    installationId: text('installation_id'),
    repoFullName: text('repo_full_name'),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    /** What we did: ignored | setup-merged | spec-merged | reindex | unmatched… */
    outcome: text('outcome').notNull(),
    detail: text('detail'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('webhook_deliveries_received_idx').on(t.receivedAt),
    index('webhook_deliveries_project_idx').on(t.projectId, t.receivedAt),
  ],
);

export type User = typeof users.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Repository = typeof repositories.$inferSelect;
export type Connection = typeof connections.$inferSelect;
export type Ticket = typeof tickets.$inferSelect;
export type Spec = typeof specs.$inferSelect;
export type AgentRun = typeof agentRuns.$inferSelect;
export type KnowledgeDoc = typeof knowledgeDocs.$inferSelect;
export type KnowledgeChunk = typeof knowledgeChunks.$inferSelect;
export type Runner = typeof runners.$inferSelect;
