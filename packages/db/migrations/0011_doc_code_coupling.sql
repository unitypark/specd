-- Which code paths have historically changed in the same commits as a doc
-- (0013). Files that change together are coupled whatever the import graph
-- says, and that is the question the file tree cannot answer.
--
-- Its own table rather than a row in knowledge_doc_links: every row there
-- points at a doc and three consumers rely on that — broken-link counts,
-- one-hop expansion, and the doc-links UI. A coupling row points at a code
-- path, has no resolved doc, and can never be expanded across.
CREATE TABLE IF NOT EXISTS knowledge_doc_coupling (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  doc_id uuid NOT NULL REFERENCES knowledge_docs(id) ON DELETE CASCADE,
  code_path text NOT NULL,
  /** Commits in the mined window that touched both this doc and this path. */
  commits_together integer NOT NULL DEFAULT 0,
  /** Last time they moved together — old coupling is weaker evidence. */
  last_together_at timestamptz,
  /** Commits touching this path since the doc itself last changed: the drift. */
  commits_since integer NOT NULL DEFAULT 0,
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (doc_id, code_path)
);

CREATE INDEX IF NOT EXISTS knowledge_doc_coupling_doc_idx
  ON knowledge_doc_coupling (doc_id, commits_together DESC);
CREATE INDEX IF NOT EXISTS knowledge_doc_coupling_project_idx
  ON knowledge_doc_coupling (project_id);
