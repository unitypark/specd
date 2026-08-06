-- specd initial schema.
-- Postgres + pgvector: one store for tenancy and the knowledge index (§9).

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ─── identity ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  name          text NOT NULL,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (lower(email));

CREATE TABLE IF NOT EXISTS projects (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             text NOT NULL,
  name             text NOT NULL,
  description      text,
  spend_cap_cents  integer NOT NULL DEFAULT 10000,
  default_model    text NOT NULL DEFAULT 'claude-opus-5',
  agents_paused    boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS projects_slug_key ON projects (slug);

CREATE TABLE IF NOT EXISTS memberships (
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'reviewer',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, project_id)
);
CREATE INDEX IF NOT EXISTS memberships_project_idx ON memberships (project_id);

-- ─── connections & repos ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS connections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  kind              text NOT NULL,
  provider          text NOT NULL,
  label             text,
  settings          jsonb NOT NULL DEFAULT '{}'::jsonb,
  encrypted_secret  text,
  status            text NOT NULL DEFAULT 'connected',
  last_validated_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS connections_project_kind_idx ON connections (project_id, kind);

CREATE TABLE IF NOT EXISTS repositories (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  connection_id   uuid REFERENCES connections (id) ON DELETE SET NULL,
  provider        text NOT NULL,
  external_id     text,
  name            text NOT NULL,
  local_path      text,
  default_branch  text NOT NULL DEFAULT 'main',
  is_primary      boolean NOT NULL DEFAULT false,
  stack           jsonb,
  setup_branch    text,
  setup_pr_url    text,
  setup_state     text NOT NULL DEFAULT 'pending',
  kb_status       text NOT NULL DEFAULT 'none',
  last_indexed_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS repositories_project_idx ON repositories (project_id);
CREATE UNIQUE INDEX IF NOT EXISTS repositories_project_name_key ON repositories (project_id, name);
-- Exactly one primary repo per project — the as-built spec needs one home (D8).
CREATE UNIQUE INDEX IF NOT EXISTS repositories_one_primary_key
  ON repositories (project_id) WHERE is_primary;

-- ─── board & specs ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tickets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  key          text NOT NULL,
  title        text NOT NULL,
  body         text NOT NULL DEFAULT '',
  source       text NOT NULL DEFAULT 'native',
  external_key text,
  external_url text,
  column_key   text NOT NULL DEFAULT 'backlog',
  position     integer NOT NULL DEFAULT 0,
  assignee     text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tickets_project_key_key ON tickets (project_id, key);
CREATE INDEX IF NOT EXISTS tickets_project_column_idx ON tickets (project_id, column_key);

CREATE TABLE IF NOT EXISTS specs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id           uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  ticket_id            uuid NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
  version              integer NOT NULL,
  status               text NOT NULL DEFAULT 'draft',
  content              jsonb NOT NULL,
  citation_count       integer NOT NULL DEFAULT 0,
  unverified_count     integer NOT NULL DEFAULT 0,
  approved_by_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,
  approved_by_name     text,
  approved_at          timestamptz,
  supersedes_id        uuid,
  created_by_run_id    uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  -- Approval is a recorded human act or it is not an approval (§8 stage 4).
  CONSTRAINT specs_approval_is_attributed
    CHECK ((status <> 'approved') OR (approved_by_name IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS specs_ticket_version_key ON specs (ticket_id, version);
CREATE INDEX IF NOT EXISTS specs_project_status_idx ON specs (project_id, status);

CREATE TABLE IF NOT EXISTS spec_comments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  spec_id        uuid NOT NULL REFERENCES specs (id) ON DELETE CASCADE,
  section        text NOT NULL,
  author_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  author_name    text NOT NULL,
  body           text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS spec_comments_spec_idx ON spec_comments (spec_id);

-- ─── runs ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_runs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id           uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  kind                 text NOT NULL,
  runner               text NOT NULL DEFAULT 'hosted',
  model                text,
  status               text NOT NULL DEFAULT 'queued',
  triggered_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  triggered_by_name    text,
  ticket_id            uuid REFERENCES tickets (id) ON DELETE SET NULL,
  repository_id        uuid REFERENCES repositories (id) ON DELETE SET NULL,
  input_tokens         integer NOT NULL DEFAULT 0,
  output_tokens        integer NOT NULL DEFAULT 0,
  cache_read_tokens    integer NOT NULL DEFAULT 0,
  cache_write_tokens   integer NOT NULL DEFAULT 0,
  cost_cents           integer NOT NULL DEFAULT 0,
  error                text,
  result               jsonb,
  started_at           timestamptz,
  finished_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_runs_project_created_idx ON agent_runs (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_runs_project_status_idx ON agent_runs (project_id, status);

CREATE TABLE IF NOT EXISTS run_logs (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id  uuid NOT NULL REFERENCES agent_runs (id) ON DELETE CASCADE,
  seq     integer NOT NULL,
  level   text NOT NULL DEFAULT 'info',
  message text NOT NULL,
  at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS run_logs_run_seq_key ON run_logs (run_id, seq);

-- ─── knowledge index (derived data only — git stays the truth, D4) ───────────

CREATE TABLE IF NOT EXISTS knowledge_docs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  repository_id  uuid NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  path           text NOT NULL,
  kind           text NOT NULL DEFAULT 'doc',
  title          text,
  sha            text NOT NULL,
  content        text NOT NULL,
  doc_updated_at timestamptz,
  indexed_at     timestamptz NOT NULL DEFAULT now(),
  has_unverified boolean NOT NULL DEFAULT false,
  is_stub        boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_docs_repo_path_key ON knowledge_docs (repository_id, path);
CREATE INDEX IF NOT EXISTS knowledge_docs_project_idx ON knowledge_docs (project_id);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id     uuid NOT NULL REFERENCES knowledge_docs (id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  ord        integer NOT NULL,
  heading    text,
  text       text NOT NULL,
  tokens     integer NOT NULL DEFAULT 0,
  embedding  vector(1024),
  -- Lexical half of hybrid retrieval. Generated, so it can never drift from
  -- the text it indexes.
  tsv        tsvector GENERATED ALWAYS AS (
               to_tsvector('english', coalesce(heading, '') || ' ' || text)
             ) STORED
);
CREATE INDEX IF NOT EXISTS knowledge_chunks_doc_idx ON knowledge_chunks (doc_id);
CREATE INDEX IF NOT EXISTS knowledge_chunks_project_idx ON knowledge_chunks (project_id);
CREATE INDEX IF NOT EXISTS knowledge_chunks_tsv_idx ON knowledge_chunks USING gin (tsv);
CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_idx
  ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS knowledge_health (
  project_id     uuid PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  score          real NOT NULL DEFAULT 0,
  doc_count      integer NOT NULL DEFAULT 0,
  stale_count    integer NOT NULL DEFAULT 0,
  stub_count     integer NOT NULL DEFAULT 0,
  as_built_count integer NOT NULL DEFAULT 0,
  notes          jsonb NOT NULL DEFAULT '[]'::jsonb,
  computed_at    timestamptz NOT NULL DEFAULT now()
);

-- ─── runners & CLI auth ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS runners (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name         text NOT NULL,
  pair_code    text NOT NULL,
  paired_at    timestamptz,
  last_seen_at timestamptz,
  token_hash   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS runners_pair_code_key ON runners (pair_code);

CREATE TABLE IF NOT EXISTS device_codes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_code  text NOT NULL,
  user_code    text NOT NULL,
  status       text NOT NULL DEFAULT 'pending',
  user_id      uuid REFERENCES users (id) ON DELETE CASCADE,
  issued_token text,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS device_codes_device_code_key ON device_codes (device_code);
CREATE UNIQUE INDEX IF NOT EXISTS device_codes_user_code_key ON device_codes (user_code);
