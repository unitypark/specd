-- The first thing specd indexes that is not a document.
--
-- Docs reference code constantly — this repository's own knowledge tree names
-- 25+ source paths — and until now every one of them was invisible: the
-- pathref extractor required a `.md` suffix, so `apps/api/src/main.ts` in an
-- ADR produced no edge of any kind. A doc could point at a file deleted two
-- renames ago and nothing would ever say so.
--
-- `kind` is 'file' today. Symbols (function, class, method) land in the same
-- table with a span and a dotted qualified_name, which is why the columns are
-- here now rather than being migrated in later.
CREATE TABLE IF NOT EXISTS code_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  /** file | (later) function | class | method | interface */
  kind text NOT NULL DEFAULT 'file',
  path text NOT NULL,
  /** Dotted identity for a symbol; the path itself for a file. */
  qualified_name text NOT NULL,
  start_line integer,
  end_line integer,
  /** Content identity, for telling "moved" from "changed" — the STALE verdict. */
  blob_sha text,
  indexed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repository_id, kind, qualified_name)
);

CREATE INDEX IF NOT EXISTS code_nodes_project_idx ON code_nodes (project_id);
CREATE INDEX IF NOT EXISTS code_nodes_path_idx ON code_nodes (repository_id, path);
-- Suffix lookup: a doc writes `runner-jobs.service.ts`, the node is the full
-- path. code-graph-rag's own benchmark puts this at 48% of query CPU when it
-- is unindexed, so it goes in on day one rather than after it hurts.
CREATE INDEX IF NOT EXISTS code_nodes_suffix_idx
  ON code_nodes (project_id, reverse(qualified_name) text_pattern_ops);

-- A link's target is a doc or a code node, decided by its kind. Two nullable
-- columns rather than one polymorphic id, so both keep real foreign keys and
-- a deleted target still nulls itself out.
ALTER TABLE knowledge_doc_links
  ADD COLUMN IF NOT EXISTS resolved_code_id uuid REFERENCES code_nodes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS knowledge_doc_links_code_idx
  ON knowledge_doc_links (project_id, resolved_code_id)
  WHERE resolved_code_id IS NOT NULL;
