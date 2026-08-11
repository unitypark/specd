-- Wizard draft projects. The wizard has to create the project row at step 1 —
-- connections, repositories and onboarding all hang off it — but a row born
-- that way is a draft, not a project, until setup completes. NULL means the
-- wizard never finished: the dashboard offers resume/discard instead of
-- listing it as real.
ALTER TABLE projects ADD COLUMN setup_completed_at timestamptz;

-- Every project that exists predates the distinction and is live.
UPDATE projects SET setup_completed_at = created_at;
