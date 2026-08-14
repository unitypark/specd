-- What each index run changed in what the project knows.
--
-- The run already computes all of this inside its transaction — which docs were
-- added, changed or removed, which links resolved, what the health score was
-- before and after — and then threw every number away, returning three counts
-- to a log line nobody reads twice. The question a reviewer actually asks after
-- a merge is "what did that change in what we know?", and until now the honest
-- answer was to go and diff the knowledge base by hand.
--
-- Written inside the same transaction as the run it describes, so a rolled-back
-- run leaves no digest claiming work that never landed.
CREATE TABLE knowledge_index_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Nulled rather than cascaded: a repository can be disconnected and its
  -- history is still the project's history. `repo_name` is denormalised for
  -- exactly that case — after the reference goes, the name is all that is left
  -- to say which repo this was.
  repository_id uuid REFERENCES repositories(id) ON DELETE SET NULL,
  repo_name text NOT NULL,

  docs_added integer NOT NULL DEFAULT 0,
  docs_changed integer NOT NULL DEFAULT 0,
  docs_removed integer NOT NULL DEFAULT 0,
  -- Content unchanged, but re-extracted because the link extractor moved on.
  docs_relinked integer NOT NULL DEFAULT 0,

  links_resolved integer NOT NULL DEFAULT 0,
  links_broken integer NOT NULL DEFAULT 0,

  -- Nullable on purpose. A project indexed for the first time has no "before",
  -- and reporting 0 would read as a collapse from a perfect score rather than
  -- as the absence it is — the same distinction `freshness` already draws
  -- between unmeasured and good.
  health_before real,
  health_after real,

  created_at timestamptz NOT NULL DEFAULT now()
);

-- The only read is "the recent runs for this project, newest first".
CREATE INDEX knowledge_index_runs_project_idx
  ON knowledge_index_runs (project_id, created_at DESC);
