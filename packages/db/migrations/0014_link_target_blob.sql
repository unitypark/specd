-- The blob sha of a link's target when the source doc was last indexed.
--
-- A doc's links are rewritten only when that doc changes, so this sha stays
-- frozen at the moment someone last touched the doc. Compare it to the target
-- file's sha now and the difference is exactly "the code moved and nobody
-- revisited the doc" — which is what a stale reference is, as opposed to a
-- broken one where the target is gone entirely.
ALTER TABLE knowledge_doc_links
  ADD COLUMN IF NOT EXISTS target_blob_sha text;
