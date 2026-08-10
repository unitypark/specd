-- History for repositories specd cannot clone (0013 follow-up).
--
-- The GitHub and GitLab adapters are REST clients with no working tree, so
-- `git log` is unavailable and crawling history through a paginated API would
-- be rate-limit suicide. But a push webhook already carries what history
-- mining needs — sha, timestamp, and the files each commit touched — so the
-- ledger is filled from deliveries as they arrive rather than fetched.
--
-- Only default-branch pushes are recorded: coupling should reflect what
-- actually landed, not work on a branch that may never merge.
CREATE TABLE IF NOT EXISTS repo_commits (
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  sha text NOT NULL,
  committed_at timestamptz NOT NULL,
  /** Repo-relative paths this commit touched. */
  files jsonb NOT NULL DEFAULT '[]'::jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repository_id, sha)
);

-- Every read is "this repo, inside this window".
CREATE INDEX IF NOT EXISTS repo_commits_window_idx
  ON repo_commits (repository_id, committed_at DESC);
