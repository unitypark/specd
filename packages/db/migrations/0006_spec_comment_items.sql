-- Comments on UNVERIFIED design items (S-105): a comment already attaches to
-- a spec and a section (0001_init), but not to the specific claim within
-- content.design a reviewer is asking about.

ALTER TABLE spec_comments
  ADD COLUMN IF NOT EXISTS item_index integer;
