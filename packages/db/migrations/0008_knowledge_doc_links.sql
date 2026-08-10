-- S-102: the knowledge graph. One row per outbound link found in a doc.
--
-- Deterministically extracted (no model calls — a hallucinated edge poisons
-- retrieval invisibly), replaced per source doc on re-index, and re-resolved
-- cheaply against unchanged docs afterwards. Unresolved links are kept, not
-- dropped: a broken link is a health signal, and deleting it would hide it.
CREATE TABLE IF NOT EXISTS knowledge_doc_links (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_doc_id    uuid NOT NULL REFERENCES knowledge_docs(id) ON DELETE CASCADE,
  -- wikilink | citation | mdlink | pathref
  kind             text NOT NULL,
  -- Where in the source doc the link occurs: the nearest heading's anchor.
  -- The relation *site*, so a rendered edge is checkable like a citation.
  site             text,
  raw_target       text NOT NULL,
  resolved_doc_id  uuid REFERENCES knowledge_docs(id) ON DELETE SET NULL,
  resolved_anchor  text,
  -- resolved | unresolved | dangling_anchor  (target doc exists, anchor does not)
  resolution_state text NOT NULL DEFAULT 'unresolved',
  -- 'deterministic' today. The column exists so a later LLM-derived tier can
  -- coexist: a re-extract of one tier must never wipe the other.
  origin_tier      text NOT NULL DEFAULT 'deterministic',
  created_at       timestamptz NOT NULL DEFAULT now()
  -- No CHECK tying resolution_state to resolved_doc_id: deleting a target
  -- doc fires ON DELETE SET NULL, which transiently produces
  -- resolved-with-no-target before the re-resolution pass demotes it — a
  -- constraint here would veto the doc deletion itself. The state machine
  -- is enforced by reresolveLinks(), which runs in the same index pass.
);

-- Which link-extractor version last processed each doc. 0 (the default)
-- predates the graph, so every existing doc re-extracts links on its next
-- index pass — without re-chunking or re-embedding anything. Bump the
-- constant in KnowledgeService when extraction rules change and the whole
-- tree refreshes the same cheap way.
ALTER TABLE knowledge_docs ADD COLUMN IF NOT EXISTS links_version integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS knowledge_doc_links_source_idx
  ON knowledge_doc_links (project_id, source_doc_id);
CREATE INDEX IF NOT EXISTS knowledge_doc_links_target_idx
  ON knowledge_doc_links (project_id, resolved_doc_id);
