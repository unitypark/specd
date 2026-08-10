-- Graph health existed only as prose. `recomputeHealth` counted broken links,
-- dangling anchors and orphans, wrote them into sentences inside `notes`, and
-- threw the numbers away — so nothing could badge, sort, trend or alert on
-- them, and they contributed nothing to the score they were describing.
ALTER TABLE knowledge_health
  ADD COLUMN IF NOT EXISTS broken_links integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dangling_anchors integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS orphan_docs integer NOT NULL DEFAULT 0,
  -- Docs whose freshness cannot be measured at all: no commit date, which is
  -- every doc of a hosted repo today. Counting them as fresh was a false
  -- negative that hid rot; counting them as stale would be a false alarm.
  ADD COLUMN IF NOT EXISTS unknown_freshness_count integer NOT NULL DEFAULT 0;

-- Commits touching code (not knowledge/) since this doc last changed. The
-- drift signal `knowledge/README.md` has always advertised: until now the only
-- thing behind that claim was a 90-day timer, which measures the calendar
-- rather than the codebase. Null where the provider gives us no commit date.
ALTER TABLE knowledge_docs
  ADD COLUMN IF NOT EXISTS code_commits_since integer;

-- Named in S-102's Design and never created; recorded as outstanding in its
-- Deviations. Serves the re-resolution pass and both graph-health counts,
-- all of which look for rows that are *not* resolved — which is the minority,
-- so the index stays small.
CREATE INDEX IF NOT EXISTS knowledge_doc_links_pending_idx
  ON knowledge_doc_links (project_id, resolution_state)
  WHERE resolution_state <> 'resolved';
