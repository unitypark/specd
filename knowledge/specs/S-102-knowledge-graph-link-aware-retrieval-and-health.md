<!-- Filed automatically by specd when S-102 was built. -->
<!-- This is a historical record: never rewrite it. If reality later -->
<!-- diverged, append a "## Deviations" section below.              -->
# S-102 — Knowledge graph: link-aware retrieval and health

> spec v1 · status: approved
> approved by Theo on 2026-08-10T02:36:58.580Z

## Requirements

### As a SpecAgent consumer, I want retrieval expanded one hop across doc links so that a spec can legitimately cite material the flat RRF shot missed.

- **WHEN** a retrieval request completes its RRF fusion stage **THE SYSTEM SHALL** return the RRF-selected chunks in their original order and rank, unmodified by graph expansion
- **WHEN** graph expansion runs for a set of seed docs **THE SYSTEM SHALL** add at most the configured expansion budget of additional chunks drawn from 1-hop neighbour docs of the seed docs
- **WHEN** a chunk is added by graph expansion **THE SYSTEM SHALL** mark that chunk's provenance as via: 'graph' and record the edge id that pulled it in
- **WHERE** a neighbour doc's link degree exceeds the configured hub threshold **THE SYSTEM SHALL** NOT traverse through that doc unless it is itself an RRF seed
- **WHEN** candidate neighbour chunks exceed the expansion budget **THE SYSTEM SHALL** rank candidates by edge-kind weight and admit only the highest-weighted up to the budget
- **IF** a project has no resolved edges touching the seed docs **THE SYSTEM SHALL** return the RRF result unchanged and record an expansion count of zero

### As a knowledge indexer, I want links extracted deterministically with provenance so that no edge in the graph is invented.

- **WHEN** a knowledge doc is indexed **THE SYSTEM SHALL** extract its outbound links using parser rules only, issuing no model call during extraction
- **WHEN** a link is extracted **THE SYSTEM SHALL** persist its kind as one of wikilink, citation, mdlink or pathref
- **WHEN** a link is extracted **THE SYSTEM SHALL** persist the source heading anchor at which the link occurs as the edge site
- **WHEN** a link is extracted **THE SYSTEM SHALL** persist the raw target text exactly as written in the source doc
- **IF** a link's target cannot be resolved to a known doc id **THE SYSTEM SHALL** persist the edge with resolution state 'unresolved' rather than discarding it
- **WHEN** an edge row is written **THE SYSTEM SHALL** set an origin/tier column identifying the deterministic extractor as the producer
- **WHEN** an extraction tier is re-extracted for a doc **THE SYSTEM SHALL** replace only edges whose origin matches that tier
- **WHEN** any producer resolves a wiki-link stem, a spec id, a relative path or a citation anchor **THE SYSTEM SHALL** resolve it through the single shared normalize/resolve module
- **WHEN** the same target text is resolved twice against unchanged doc state **THE SYSTEM SHALL** return the identical resolved doc id

### As a platform operator, I want re-indexing to stay incremental and to refuse destructive commits so that the graph cannot silently shrink.

- **WHEN** a single doc changes and is re-indexed **THE SYSTEM SHALL** delete and rewrite only that doc's outbound edges
- **WHEN** an index run completes edge writes **THE SYSTEM SHALL** run a SQL re-resolution pass that binds previously unresolved edges against currently known docs without re-parsing any doc
- **WHEN** a newly created doc is indexed **THE SYSTEM SHALL** bind pre-existing unresolved edges whose targets now resolve to that doc
- **IF** an index transaction would remove docs whose sources were neither re-indexed nor deleted in that run **THE SYSTEM SHALL** abort the transaction with an explicit shrink-guard error
- **IF** an index transaction would remove edges whose source docs were neither re-indexed nor deleted in that run **THE SYSTEM SHALL** abort the transaction with an explicit shrink-guard error

### As a knowledge maintainer, I want graph health signals so that broken links and orphaned docs stop being silent.

- **WHEN** knowledge health notes are produced **THE SYSTEM SHALL** include the count of unresolved (broken) links
- **WHEN** knowledge health notes are produced **THE SYSTEM SHALL** include the count of citation links whose target doc resolves but whose anchor does not exist in that doc
- **WHEN** knowledge health notes are produced **THE SYSTEM SHALL** include the count of docs having zero inbound resolved edges across all four link syntaxes
- **WHEN** the doc list API returns a doc **THE SYSTEM SHALL** include that doc's outbound links and inbound backlinks with each link's kind and site

### As a spec reviewer, I want prompt assembly to announce truncation so that an agent never reads a cut knowledge block as an absence of evidence.

- **WHEN** matched knowledge material is cut to fit the prompt budget **THE SYSTEM SHALL** prepend a notice to the knowledge block stating the number of matched items omitted
- **IF** no matched material was cut **THE SYSTEM SHALL** omit the truncation notice entirely

## Design

- Edges are ordinary Postgres rows and expansion is a SQL join against them — no graph database and no in-memory graph store. This matches the project's standing preference for removing rather than adding infrastructure dependencies: the last queue-shaped dependency was deleted precisely so `pnpm infra:up` starts one container and a self-hoster runs one less service. _(per knowledge/decisions/0008-remove-unused-queue.md#consequences)_
- Where the edge-expansion or re-resolution queries cannot be expressed in Drizzle's query builder, use `DB_HANDLE`'s raw `postgres.Sql` client — this is an established precedent in the codebase (KnowledgeService already does it, and `RunnerJobsService.claim()` follows it for its atomic UPDATE...FOR UPDATE SKIP LOCKED). _(per knowledge/decisions/0004-runner-job-dispatch.md#decision)_
- Graph expansion must sit inside the retrieval path that `SpecAgent.prepare()` owns (retrieval + prompt assembly, all DB-dependent), not inside `finalize()`, which is pure and normalizes an already-parsed reply against already-retrieved chunks. Because the dispatched runner path calls `prepare()` directly and `finalize()` on report, putting expansion in `prepare()` gets identical retrieval breadth on both the synchronous and dispatched paths for free. _(per knowledge/decisions/0004-runner-job-dispatch.md#decision)_
- Widening retrieval widens what may honestly be cited, because citations are validated against what was actually retrieved and invented paths are demoted to UNVERIFIED. Graph-expanded chunks must therefore enter the same retrieved-set that citation validation checks against, or the feature produces no citation benefit at all. _(per knowledge/conventions.md#writing-conventions-the-product-itself-enforces)_
- The citation-validation invariant is claimed to be enforced in code plus a test; the exact symbol performing the retrieved-set comparison must be read before wiring expanded chunks into it, since the architecture doc explicitly treats the mechanism as UNVERIFIED until the named symbol is read. _(per knowledge/architecture.md#invariants-claimed-to-be-enforced-in-code)_
- 'Flag, don't drop' for unresolved links is the same convention the product already enforces on itself: a claim without a checkable citation is marked UNVERIFIED rather than removed, and skipped work is labelled as skipped rather than silently passed. Unresolved edges are the graph-layer instance of that rule, and the loud truncation notice in prompt assembly is the same rule applied to omitted material. _(per knowledge/conventions.md#writing-conventions-the-product-itself-enforces)_
- The UNVERIFIED-marker precedent also argues for surfacing rather than deleting: a stale marker in `knowledge/architecture.md` survived three chances to be checked, and it was the flag being visible — not its deletion — that eventually got the claim fixed. Broken-link and orphan counts should behave the same way: persistently visible in health notes, not swept. _(per knowledge/decisions/0008-remove-unused-queue.md#consequences)_
- Wiki-link stems that are spec ids (e.g. `[[S-104]]`) must resolve to the as-built spec files under `knowledge/specs/`, which is where the final task of every spec files its as-built copy — so the spec-id resolution rule in the shared module is `S-<n>` → the `knowledge/specs/S-<n>-*.md` doc. _(per knowledge/architecture.md#invariants-claimed-to-be-enforced-in-code)_
- Citation-anchor targets in the knowledge base take the literal shape `path#anchor` (e.g. `per knowledge/decisions/0003-runner-pairing-before-dispatch.md#context`), so the citation parser splits on the first `#` and the shared resolver validates the path part against doc ids and the anchor part against that doc's heading anchors — the two failures are distinct health signals (broken link vs. dangling anchor). _(per knowledge/specs/S-104-improve-cli-app-like-claude-code-or-copilot.md#design)_
- Wiki-links in ADRs use the decision-file stem without extension or directory (e.g. `[[0004-runner-job-dispatch]]`, `[[0005-onboard-job-dispatch]]`), so the shared resolver's wikilink rule is: stem → `knowledge/decisions/<stem>.md`, falling back to a stem match across all indexed docs. _(per knowledge/decisions/0009-build-dispatch-runner-git-credentials.md#context)_
- Edge-kind weighting should rank citation edges above bare pathref edges: a `per <path>#<anchor>` citation is an author asserting that the target grounds this specific claim, whereas a backticked path reference is frequently incidental (e.g. `docker-compose.yml`, `packages/db/src/schema.ts` mentioned in passing inside a context section). _(per knowledge/decisions/0003-runner-pairing-before-dispatch.md#context)_
- Four extraction passes are required and they are structurally different searches — a single regex family cannot see all of them. This is the same lesson the rebrand sweep recorded twice: a token sweep and a literal-colour sweep found disjoint call sites (20 then 11 more), and the second pass caught what the first 'by construction could only' miss. Each link syntax gets its own tested extractor with its own fixtures. _(per knowledge/decisions/0007-rebrand-golden-spiral.md#the-reference-sweep-needed-two-passes-not-one)_
- Fuzzy/approximate target matching is deliberately excluded from the shared resolver: resolution is exact-after-normalization or unresolved. Anything short of that reintroduces the silent-data-loss class the ticket flags, and silent loss is the failure mode this codebase's conventions treat as worse than a visible gap. _(per knowledge/conventions.md#writing-conventions-the-product-itself-enforces)_
- The proposed edge table columns are: id, project_id, source_doc_id, kind, site (source heading anchor), raw_target, resolved_doc_id (nullable), resolved_anchor (nullable), resolution_state, origin_tier. A partial index on (project_id, resolution_state) serves the re-resolution pass and the broken-link health count; an index on (project_id, resolved_doc_id) serves backlinks and expansion joins. _(**UNVERIFIED** — confirm exact table/column naming conventions and migration workflow against packages/db/src/schema.ts with the DB owner)_
- Hub suppression needs a concrete degree threshold; the ticket's own measurement (20 docs, 12 strict links, 11 docs with no inbound link) suggests inbound degree is currently very low, so a fixed threshold tuned on this repo may not generalize to a large customer knowledge base — prefer a configurable threshold with a percentile-based default. _(**UNVERIFIED** — confirm expansion budget default and hub-degree threshold with the retrieval owner; needs measurement on a larger knowledge base than this repo)_
- The existing retrieval provenance enum currently carries vector|fulltext|both; adding 'graph' is an additive change to that type and to whatever run-log rendering consumes it, but the exact enum location and whether it is a DB enum or a TS union was not shown. _(**UNVERIFIED** — read the retrieval provenance type in the knowledge/retrieval service before writing the migration)_
- The shrink guard belongs inside the existing index transaction and should compare, pre-commit, the set of doc ids and edge ids about to be deleted against the set of sources re-indexed or deleted in this run, raising and rolling back on any excess. The current index transaction's boundaries and whether re-index is full-corpus or per-doc today were not shown in the knowledge base. _(**UNVERIFIED** — read the knowledge index/ingest service to locate the transaction boundary and current re-index granularity)_
- Health note and doc-list API shapes must be extended rather than duplicated, following the project's consistent preference for extending an existing surface over building a parallel one (the REPL reuses the exact same `cmd*` functions rather than reimplementing them). _(per knowledge/decisions/0006-cli-repl-bubbletea.md#decision)_
- An LLM-derived edge tier is explicitly not built now, but the origin_tier column ships now so a later deterministic re-extract cannot wipe a model-derived tier. This mirrors how the queue removal deliberately left the seam in place while removing the mechanism. _(per knowledge/decisions/0008-remove-unused-queue.md#consequences)_

### Out of scope

- LLM/model-derived edge extraction — only the origin/tier column ships, not a second tier
- Community detection, clustering, or any doc grouping derived from the graph
- Fuzzy label dedup or approximate target matching in the resolver
- Any graph visualization UI; links/backlinks are API and health-note data only
- Cross-project graphs — edges are scoped to a single project
- Retrieval-outcome feedback loops that tune expansion weights from downstream results
- Changes to embedding providers, the pgvector/tsvector queries, or the RRF fusion itself
- Multi-hop (2+) expansion; only 1-hop neighbours of seed docs are considered
- Auto-fixing or rewriting broken links in knowledge docs — they are reported only

## Tasks

- [ ] **T1** Add shared normalize/resolve module (wikilink stem, spec id, relative path, citation anchor) with fixture tests; no callers yet — _M · unitypark/specd_
- [ ] **T2** Add knowledge_doc_links schema + migration (kind, site, raw_target, resolved_doc_id, resolved_anchor, resolution_state, origin_tier) with indexes — _S · unitypark/specd_
- [ ] **T3** Add four deterministic link extractors (wikilink, citation, mdlink, pathref) resolving through T1, with per-syntax fixtures — _M · unitypark/specd_
- [ ] **T4** Wire extraction into the index transaction: per-doc outbound edge replacement scoped by origin_tier, plus SQL re-resolution pass — _M · unitypark/specd_
- [ ] **T5** Add shrink guard to the index transaction — fail and roll back on unexplained doc or edge deletions — _S · unitypark/specd_
- [ ] **T6** Extend knowledge health notes and doc list API with broken-link, dangling-anchor, orphan counts and per-doc links/backlinks — _M · unitypark/specd_
- [ ] **T7** Add bounded 1-hop graph expansion after RRF in SpecAgent.prepare() retrieval, with via:'graph' provenance, edge-kind weighting and hub suppression — _L · unitypark/specd_
- [ ] **T8** Make prompt assembly announce truncation with an omitted-item count at the top of the knowledge block — _S · unitypark/specd_
- [ ] **T9** Verify graph-expanded chunks enter the citation-validation retrieved-set; add a test that a graph-only citation is accepted and an unretrieved one is still demoted to UNVERIFIED — _M · unitypark/specd_
- [ ] **T10** commit as-built spec → knowledge/specs/S-102-knowledge-graph-link-aware-retrieval-and-health.md — _S · unitypark/specd_

## Open questions

- What is the default expansion budget (extra chunks per retrieval) and how does it interact with the existing prompt token budget? Sizing T7 and T8 depends on this.
- What is the hub-degree threshold above which a doc is not expanded through, and is it fixed, configurable, or percentile-derived?
- What are the relative edge-kind weights (wikilink vs citation vs mdlink vs pathref) for ranking expansion candidates?
- Is the current knowledge re-index full-corpus or per-doc today? The shrink guard's definition of 'sources re-indexed in this run' (T5) differs materially between the two.
- Where does retrieval provenance (via: vector|fulltext|both) live — DB enum or TS union — and what renders it in the run log?
- Does a `pathref` (backticked path) pointing at source code rather than a knowledge doc create an unresolved edge, or is it excluded from extraction entirely? This changes the broken-link count's meaning.
- Are anchors in citations validated against generated heading slugs, and what slugification rule does the existing knowledge indexer use?
- Should orphan detection count inbound edges from any doc, or exclude inbound edges from README-like hub docs (which would otherwise mask genuine orphans)?

## Verification

`pnpm typecheck && pnpm test` — passed

## Deviations

- **Extractor versioning was added** (`knowledge_docs.links_version`,
  `LINKS_VERSION`). The spec assumed link extraction would ride the existing
  sha-skip; the first live run showed 18 of 20 docs skipped — docs indexed
  before the graph existed would never enter it until they happened to
  change. A version stamp re-extracts links for sha-unchanged docs without
  re-chunking or re-embedding.
- **Unresolved paths outside knowledge/ are not stored.** The first live
  sweep reported 7 "broken" links that were all references to real files
  (`docs/runners.md`, `README.md`) outside the graph's scope — false alarms,
  which a health signal cannot afford. v2 of the extractor keeps unresolved
  rows only for wikilinks and explicitly knowledge/-rooted paths. The
  flag-don't-drop rule bends here, knowingly: a typo'd tree-relative path is
  silently skipped, and that trade is documented in code.
- **No CHECK constraint on resolution consistency.** The planned
  `resolved ⇒ resolved_doc_id` CHECK conflicted with `ON DELETE SET NULL` —
  deleting a target doc transiently produces resolved-with-no-target, so the
  constraint vetoed the deletion itself (found by the integration tests).
  The state machine is enforced by the re-resolution pass in the same index
  run instead.
- **Open-question defaults chosen at build time:** expansion budget 4
  chunks, hub-degree gate 20, edge weights citation 1.0 > wikilink 0.9 >
  mdlink 0.6 > pathref 0.4 — code constants, not env, until real usage says
  they need tuning. The `via` enum gained `'graph'` additively plus a
  `viaEdge` provenance string; the shrink guard is a pre-delete assertion in
  the index pass, so a refused run aborts before any row is removed.

### Appended 2026-08-10 — foundation hardening

A file-level audit of the as-built engine found three requirements above that
the original build did not actually meet. They are recorded here rather than
quietly fixed, and the fixes landed together.

- **There was no transaction.** Two requirements say a guard "SHALL abort the
  transaction"; every write autocommitted instead. The failure that made this
  more than pedantry: a doc's chunks are deleted before its replacements are
  written, so a run that died in between left the doc's row saying "indexed"
  with nothing retrievable behind it. The write half of `indexRepository` now
  runs as one transaction. The slow, fallible work — the VCS listing, the file
  reads, the embedding call — was hoisted out of it first, because a
  transaction held open across a network round trip is a lock held across a
  network round trip.
- **The doc-level shrink guard is a credibility heuristic, not the provenance
  check the requirement describes** — and it cannot be one. Every removal is
  by definition a path the listing did not return, so nothing distinguishes
  "deleted on purpose" from "listing failed" at that layer. What was added is
  the case the count floor let through: a listing that comes back *empty*
  while the index holds docs is now refused at any size (three docs vanishing
  from a three-doc repo used to pass silently). The >50% rule stands as it was.
- **The edge shrink guard had no implementation at all.** It now exists, and
  unlike the doc guard it is a real provenance check: edges may only disappear
  for a doc that this run re-extracted or deleted, and any other source doc
  losing edges rolls the whole transaction back.

Known and still outstanding, deliberately, so the next pass has them written
down rather than rediscovered:

- The re-resolution pass is an application loop over pending edges, not the
  SQL pass the requirement names. The behaviour matches; the query count does
  not.
- ~~The `(project_id, resolution_state)` partial index named in the Design was
  never created.~~ Created 2026-08-10 as
  `knowledge_doc_links_pending_idx`, partial on `resolution_state <> 'resolved'`
  — the rows every one of those queries is looking for are the minority.
- ~~Expansion provenance carries a readable `viaEdge` label, not the edge id
  the requirement asks for.~~ Met 2026-08-10: expanded chunks carry
  `viaEdgeId` alongside the label, and the run log prints it, so provenance
  joins back to the row instead of being parsed out of a sentence. Expanded
  chunks also carry a real discounted score (seed score × edge weight × 0.5)
  rather than zero; ordering is unchanged, since expansion is appended and
  never displaces an RRF pick.
- The doc *list* API returns no links or backlinks; only the single-doc
  endpoint does, and nothing in the web app calls it yet.
