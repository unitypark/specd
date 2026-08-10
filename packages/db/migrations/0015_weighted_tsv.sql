-- A heading match and a body match were worth the same.
--
-- `to_tsvector('english', heading || ' ' || text)` flattens the two, so a doc
-- whose *section title* is "Reclaiming jobs abandoned by a dead runner" ranked
-- no higher for that phrase than one that mentions the words in passing. A
-- heading is the strongest statement a doc makes about what a passage is for,
-- and ts_rank_cd already knows how to use that: weight A counts 1.0 against
-- weight B's 0.4.
--
-- The column is generated, and a generated expression cannot be altered in
-- place, so this drops and re-adds it. Postgres recomputes every row and
-- rebuilds the index — a table rewrite, cheap at knowledge-base scale and
-- worth knowing about before running it on a large one. No re-index is needed:
-- the chunks themselves do not change.
DROP INDEX IF EXISTS knowledge_chunks_tsv_idx;
ALTER TABLE knowledge_chunks DROP COLUMN IF EXISTS tsv;

ALTER TABLE knowledge_chunks
  ADD COLUMN tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(heading, '')), 'A') ||
    setweight(to_tsvector('english', text), 'B')
  ) STORED;

CREATE INDEX IF NOT EXISTS knowledge_chunks_tsv_idx ON knowledge_chunks USING gin (tsv);
