-- A doc's chunks are a function of (source content, chunker, embedder), but
-- the incremental skip keyed only on the first: change the chunk bounds or
-- point SPECD_EMBEDDING_PROVIDER at a different model and every unchanged doc
-- keeps rows built by the old one. With embeddings that is not merely stale,
-- it is incoherent — two vector spaces in one HNSW index, and cosine distance
-- between them means nothing.
--
-- Stamping the pair the chunks were built with turns that into a detectable
-- mismatch: a doc whose fingerprint differs is re-chunked and re-embedded even
-- though its sha is untouched.
--
-- Existing rows default to '' and so re-index once on the next run, which is
-- correct — nothing recorded what built them.
ALTER TABLE knowledge_docs
  ADD COLUMN IF NOT EXISTS index_fingerprint text NOT NULL DEFAULT '';
