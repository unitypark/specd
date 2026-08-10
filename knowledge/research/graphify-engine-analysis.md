# Graphify engine analysis — external research

> status: point-in-time snapshot · analyzed 2026-08-10. Like `specs/`, this is
> a historical record of what was true when it was written — do not update it
> as graphify evolves; append corrections instead.

**What was analyzed:** [Graphify-Labs/graphify](https://github.com/Graphify-Labs/graphify)
at v0.9.38, single squashed commit `10ad921`, via a read-only clone. Python 3.10+,
~57.7k LOC of engine Python + ~15.9k in `graphify/extractors/`, ~24.8k LOC of
shipped markdown (the "skills"), ~65.9k LOC / 3,626 test functions in `tests/`.

**Why it exists:** commissioned as design input for specd's knowledge/graph
engine — to learn from graphify, not to import it. The clever-parts and fit
assessment sections (§7, §9) fed directly into
[S-102 — knowledge graph: link-aware retrieval and health](../specs/S-102-knowledge-graph-link-aware-retrieval-and-health.md):
tier-scoped replace-on-re-extract, the single shared normalize/resolve module,
shrink-guard aborts, hub-threshold traversal and edge-kind weights in that spec
all trace to findings below.

**Citation caveat:** every `file:line` reference below points into the
*graphify* source tree at the version above — never into this repository.

---

## 1. What graphify IS

graphify is a **local-first, LLM-free-by-default code-and-docs knowledge-graph builder packaged as an AI-assistant skill**. You run `graphify install`, then type `/graphify .` in Claude Code / Codex / Cursor / 20-odd other assistants; a huge markdown runbook (`graphify/skill.md`, 41KB, plus per-host variants and a `references/` sidecar) drives the assistant to call a Python library through a fixed pipeline — `detect() → extract() → build_graph() → cluster() → analyze() → report() → export()` (`ARCHITECTURE.md:7-9`) — producing three artifacts in `graphify-out/`: `graph.json` (NetworkX node-link), `GRAPH_REPORT.md`, `graph.html`. The consumer is an **agent, not a human UI**: an MCP server (`graphify/serve.py`) exposes `query_graph`/`get_node`/`get_neighbors`/`get_community`/`god_nodes`/`graph_stats`/`shortest_path` (+ 3 GitHub-PR tools) at `serve.py:1491-1610`, and PreToolUse hooks nudge or *block* the assistant's first raw file read to redirect it into the graph (`README.md:205`, `graphify/hooks.py`). Maturity: **YC S26 startup, aggressive pre-1.0 shipping cadence** — the CHANGELOG is 367KB / 1,732 lines and 0.9.35→0.9.38 landed inside ~4 days; issue numbers in comments reach **#2577**, so this is heavily-iterated, bug-report-driven code with an OSS core and a commercial hosted product (`app.graphify.com`) behind it. Scale it targets: single-repo to monorepo, "roughly 1M-LOC ERPNext" (`BENCHMARKS.md:64`), 22,620 nodes / 48,710 edges at the top temporal checkpoint (`BENCHMARKS.md:143`); a 512 MiB graph-file cap (`security.py:32`) and a 100k-node microbenchmark (`tests/bench_query_scoring.py`) mark the practical ceiling. Everything is a **single JSON file on disk**; there is no database.

**Notably: there are no embeddings and no vector index anywhere in this repository.** `grep -rin "embedding|vector|cosine"` over `graphify/*.py` returns only unrelated hits (YAML escaping, SSRF comments). README is explicit: *"Not a vector index. No embeddings, no vector store: a real graph you traverse"* (`README.md:33`). This matters a lot for §6 and §9.

---

## 2. The graph model

### Node schema (dict-based, not typed)

There is **no node dataclass**. Nodes are plain dicts validated by a hand-rolled validator:

```python
# graphify/validate.py:4-7
VALID_FILE_TYPES   = {"code", "document", "paper", "image", "rationale", "concept"}
VALID_CONFIDENCES  = {"EXTRACTED", "INFERRED", "AMBIGUOUS"}
REQUIRED_NODE_FIELDS = {"id", "label", "file_type", "source_file"}
REQUIRED_EDGE_FIELDS = {"source", "target", "relation", "confidence", "source_file"}
```

Actual persisted node (from `worked/httpx/graph.json`):

```json
{"label":"Limits","file_type":"code","source_file":"worked/httpx/raw/client.py",
 "source_location":"L24","id":"client_limits","community":1}
```

Other node attributes seen across the engine: `norm_label` (diacritic-stripped lowercase, precomputed at export for query speed — `export.py:305`), `community_name`, `_origin` (`"ast"` | `"semantic"` — the tier marker, `build.py:1406-1417`), `_callable` / `_callable_class` (resolver markers, `watch.py:1288-1292`), `rationale` (WHY-comments folded onto a node rather than made a node — `extraction-spec.md:19`), `verification: "unverified"` (hallucination flag, `tests/test_evidence_binding.py:1-7`), `repo` / `local_id` (multi-repo prefixing, `build.py:1868`), `source_url`/`captured_at`/`author`/`contributor` (frontmatter provenance).

### Edge schema

```json
{"relation":"imports_from","confidence":"EXTRACTED",
 "source_file":"worked/httpx/raw/client.py","source_location":"L9","weight":1.0,
 "_src":"client","_tgt":"exceptions","source":"client","target":"exceptions"}
```

Key design points:
- **`source_location` on an edge is the relation *site*** (the call/import line in the caller's file), deliberately not the callee's def line (`serve.py:1042-1049`, `affected.py:34-42`). That is a citation primitive.
- **`_src`/`_tgt` carry true direction inside an undirected graph** (`build.py:1185-1186`) because NetworkX undirected storage canonicalizes endpoint order and would silently reverse `calls` edges. Restored at serialization (`export.py:~310`).
- `confidence` ∈ {EXTRACTED, INFERRED, AMBIGUOUS}, `confidence_score` float with a **discrete rubric** the LLM must pick from — 0.95 / 0.85 / 0.75 / 0.65 / 0.55 — explicitly because "models follow discrete rubrics better than continuous ranges; the bimodal distribution observed in production (>50% at 0.5, >40% at 0.85+) shows the range guidance is being collapsed to a binary" (`extraction-spec.md:47-59`).
- `context` is a second dimension orthogonal to `relation`: `call`, `import`, `field`, `parameter_type`, `return_type`, `generic_arg`, `attribute`, `export` — used for query-time edge filtering (`serve.py:748-793`).

**Relation vocabulary** (open, not enum-enforced): `calls`, `indirect_call`, `dynamic_import`, `imports`, `imports_from`, `re_exports`, `references`, `references_constant`, `contains`, `method`, `defines`, `inherits`, `extends`, `implements`, `mixes_in`, `embeds`, `requires`, `uses`, `uses_static_prop`, `uses_component`, `instantiates`, `binds_method`, `bound_to`, `listened_by`, `includes`, `depends_on`, `crate_depends_on`, `requires_env`, `cites`, `rationale_for`, `semantically_similar_to`, `conceptually_related_to`, `shares_data_with`, `reads_from`. The affected-traversal whitelist is the closest thing to a canonical list: `affected.py:12-32`.

**Hyperedges** (3+ node group relations) live out-of-band in `G.graph["hyperedges"]`, not as nodes: `{"id","label","nodes":[...],"relation":"participate_in|implement|form","confidence","confidence_score","source_file"}` (`extraction-spec.md:64`, `build.py:1201-1255`). They are semantic-tier only, and dual-slot persisted (top-level `hyperedges` + nested `graph.hyperedges`, `build.py:754-763`).

### Identity / dedup — four layers

**Layer 0 — canonical ID recipe, one function, one module.** `graphify/ids.py` exists *because* the recipe was previously copy-pasted into the AST extractor and the builder and drifted (the docstring names four resulting bug classes: #811 Unicode collapse, #550 same-filename collisions, #1033 AST-vs-LLM mismatch, #1104):

```python
# graphify/ids.py:32
def normalize_id(s: str) -> str:
    s = unicodedata.normalize("NFKC", s)
    s = re.sub(r"[^\w]+", "_", s, flags=re.UNICODE)   # re.UNICODE keeps CJK/Cyrillic
    s = re.sub(r"_+", "_", s)
    return s.strip("_").casefold()

# graphify/ids.py:43
def make_id(*parts: str) -> str: ...
```

ID form = **full repo-relative path with extension dropped, every segment joined by `_`, plus the symbol name** (`src/auth/session.py` + `ValidateToken` → `src_auth_session_validatetoken`). This is spelled out to the LLM verbatim in `extraction-spec.md:61`, so three independent producers (AST extractor, LLM subagent, builder) agree.

**Layer 1 — deterministic semantic re-key.** Rather than trusting the LLM, `_semantic_id_remap(nodes, root)` (`build.py:589`) re-derives every non-AST node's ID from its own `source_file` in code, so a drifted or stale-cached fragment physically reconciles with the AST node instead of spawning a ghost (`build.py:837-866`).

**Layer 2 — AST-wins ghost merge.** Two passes at `build.py:922-1003`: collect canonical `(source_file, label) → id` preferring `_origin == "ast"`, then any non-AST node sharing that key is a ghost and is removed, its edges re-pointed. Ambiguous keys (two AST nodes on the same key) are recorded in `_loc_collisions` and skipped — no arbitrary winner. Iteration is `sorted()` specifically so CPython's per-process string-hash seed can't flip the winner run-to-run (`build.py:939-942`, #1753).

**Layer 3 — entity resolution proper**, `dedup.deduplicate_entities(nodes, edges, *, communities, dedup_llm_backend, root)` (`dedup.py:388`):
- Guard: raises if nodes span multiple `repo` values — *cross-project dedup is disabled by construction* (`dedup.py:409-417`).
- Pre-dedup by ID with a **total-order survivor rank**, `_collision_rank(node, root)` (`dedup.py:290`), which includes a `_lifecycle_penalty` scoring `plans/_done/x.md` below `plans/in-progress/x.md` (`dedup.py:235-272`). Losers from the same source gap-fill the survivor's missing attributes (`_merge_missing_attributes`, `dedup.py:330`) so AST structure and semantic enrichment coexist.
- Pass 1 exact-normalized-label merge, partitioned by `source_file`; cross-file exact merges are gated to `file_type == "concept"` only (`dedup.py:512-531`).
- Pass 2 **MinHash/LSH + Jaro-Winkler** over high-entropy labels only: `_ENTROPY_THRESHOLD = 2.5`, `_LSH_THRESHOLD = 0.7`, `_MERGE_THRESHOLD = 92.0`, `_COMMUNITY_BOOST = 5.0`, `_NUM_PERM = 128` (`dedup.py:169-173`). **Code nodes are excluded from all label-based matching** — they are keyed by ID only (`dedup.py:481-484`, #1205). Cross-file long labels score on plain **Jaro** (no prefix bonus) because Jaro-Winkler's prefix bonus fabricated merges (`dedup.py:586-599`, #1243). Five hard blocks regardless of score: variant-suffix pairs, short-label gate, strict prefix-extension pairs (`getActiveSession`/`getActiveSessions`), differing numeric tokens, cross-file file-anchored types (`dedup.py:601-618`).
- Union-find (`_UF`, `dedup.py:142`) → components → `_pick_winner` (prefer no `_c\d+` chunk suffix, then shorter ID, `dedup.py:725`) → remap applied to edges, self-loops dropped.
- Optional **LLM tiebreak** for the ambiguous 75–92 Jaro-Winkler band (`dedup.py:737`, opt-in via `dedup_llm_backend`).

---

## 3. Construction pipeline

### Extraction: three tiers, only one costs money

- **Pass 1 — AST, free.** `extract(paths, cache_root, *, root, parallel, max_workers, resolution_context_nodes, resolution_context_edges) -> dict` (`extract.py:5139-5188`). tree-sitter over ~100 file extensions / ~40 languages (`detect.py:32`), plus `graphify/extractors/*` for SQL, Terraform, Pascal, DreamMaker, Razor, Blade, Astro, `.sln`/`.csproj`, JSON config, markdown. Two internal passes: per-file structure, then cross-file import/call resolution producing INFERRED edges. `ProcessPoolExecutor` above a threshold. Language-specific resolvers registered via `resolver_registry.py`, with `symbol_resolution.py` (554 LOC) building typed fact tables — `_SymbolDeclarationFact`, `_SymbolImportFact`, `_SymbolAliasFact`, `_SymbolExportFact`, `_StarExportFact`, `_NamespaceExportFact`, `_SymbolUseFact` (`extractors/models.py:58-115`).
- **Pass 2 — transcription**, local faster-whisper, prompt-seeded with the current top god nodes (`docs/how-it-works.md:9`).
- **Pass 3 — semantic, costs tokens.** Parallel LLM subagents (the assistant's own model, or a configured backend in `llm.py`, 3,164 LOC, ~15 providers) over docs/PDFs/images/transcripts. **Code files are not sent to the semantic extractor in the normal pipeline; a pure-code corpus skips Pass 3 entirely** (`docs/how-it-works.md:11`). Oversized docs are sliced at heading/paragraph boundaries by `file_slice.FileSlice` but every slice reports the *parent* file as source so nodes never fragment per-slice (`file_slice.py:1-19`).

Hallucination control on the semantic tier: `verification="unverified"` is stamped on a code node whose symbol name has no textual evidence in the dispatched source — **flagged, never dropped** (`tests/test_evidence_binding.py:1-7`); `_out_of_scope` rejects nodes attributed to files that were never dispatched.

### Incremental vs full — this is the part that matters for specd

Two independent change-detection systems:

**(a) Manifest-based, semantic-aware** — `detect_incremental(root, manifest_path, *, kind="semantic"|"ast", ...)` (`detect.py:1891`). Per file the manifest stores `{mtime, ast_hash, semantic_hash}`. Fast path: mtime unchanged → unchanged, zero IO beyond `stat`. Slow path: mtime differs → MD5 compare. Two hash fields means `graphify update` (AST-only) does not mark a file semantically fresh. Deleted vs excluded are distinguished by disk existence (`detect.py:1997-2010`, #1908) — a file gone from disk is a deletion (prune it); a file still on disk but out of scan scope was excluded (do not report as deleted).

**(b) Content-hash extraction cache** — `cache.file_hash(path, root, cache_root)` (`cache.py:324`): SHA256 of *content + root-relative path salt*, with a persisted stat-index `(size, mtime_ns)` fastpath keyed by salt (`cache.py:355-370`, #1989). Markdown hashes only the body **below YAML frontmatter**, so metadata-only edits (status, reviewed, tags) don't invalidate (`cache.py:335-336`). **The AST cache is namespaced by package version** (`cache/ast/v{version}/`) and stale version dirs are swept, because extractor fixes must invalidate; **the semantic cache is deliberately unversioned** so a release doesn't re-bill an unchanged corpus (`cache.py:22-31`). The semantic cache is additionally keyed by a **12-char prompt fingerprint** (`prompt_fingerprint`, `cache.py:76-110`), so changing the extraction prompt re-extracts; pre-fingerprint entries still hit but emit a "mixed extraction vintages" `RuntimeWarning` (`cache.py:1077-1088`).

**Merge semantics** — `build_merge(new_chunks, graph_path, prune_sources, *, directed, dedup, dedup_llm_backend, root)` (`build.py:1547`). The central rule is **tier-scoped replace-on-re-extract**:

> a source_file present in `new_chunks` has its existing nodes/edges dropped *for each tier the new chunks actually contain* — so an AST-only re-extract keeps the file's semantic layer and vice versa (`build.py:1599-1648`, #2333/#2336 "COEXIST")

Deletions go through `prune_sources`, matched in three path forms (raw string, `_norm_source_file` relative, `_abs_identity` absolute) because callers pass absolute Win32 paths against relative POSIX storage (`build.py:1673-1693`). **"Replace" deterministically wins over a contradictory "delete"** of the same source (`build.py:1661-1668`, #1796). If *no* prune entry matches anything stored, it re-derives the root by suffix-matching prune paths against stored source_files and retries (`build.py:1695-1715`, #2446) — the "silent no-op prune" failure mode, caught and named. `merge_raw_extraction` (`build.py:1426`) is the mirror-image for the `--no-cluster` raw path, documented as intentionally identical so the two paths can't drift.

**Two anti-data-loss guards**, both worth stealing:
- `build_merge`'s shrink guard (`build.py:1809-1863`): diffs the *on-disk baseline* by node identity, excuses only losses explained by this run's own same-tier re-extract or an explicit prune, and **raises** on anything unexplained. The comment records that the previous version compared post-replace counts and "could never fire when it mattered."
- `export.to_json` (`export.py:232-286`): refuses to overwrite when the new graph has fewer nodes than the existing one, and **fails safe** — if the existing file is unreadable it refuses rather than clobbering.

**Incremental resolution context** (the best idea in the incremental path, `watch.py:1235-1310`): an incremental rebuild parses only changed files, so cross-file resolvers could not see callees in unchanged files and every changed→unchanged `calls` edge vanished. Fix: project the persisted graph into a **read-only resolver context** — AST-tier nodes of files *not* being re-extracted (with their `_callable`/`_callable_class` markers) plus their `contains`/`method` edges — and hand it to `extract()`. Nothing is parsed or emitted from it; only fresh edges sourced by re-extracted files are returned.

**Concurrency**: per-repo `flock` (`watch.py:159`), non-blocking for hooks, blocking for interactive `graphify update`; contenders queue their change set to `.pending_changes` *before* attempting the lock, and the winner drains and merges it, then loops up to 20 late-arrival drain passes (`watch.py:19-76`, `987-1035`, #1059).

**Cost profile — the catch.** Extraction is genuinely incremental, but everything downstream is not. On *every* rebuild `watch.py:1542` runs `cluster(G)` (full Leiden on the whole graph), then `god_nodes` (:1547), surprises, `generate()` the full report (:1608), rewrite the whole `graph.json` (:1614), and regenerate the whole `graph.html` (:1692). Community IDs are kept stable across rebuilds by `remap_communities_to_previous` (:1545) rather than by incremental clustering.

---

## 4. Storage

**A single `graph.json` file.** NetworkX node-link format (`{directed, multigraph, graph, nodes, links}`), written atomically to a temp path then moved (`tests/test_atomic_writes.py`), with the shrink guard above. Everything else in `graphify-out/` is derived: `GRAPH_REPORT.md`, `graph.html`, `graph.svg`, `wiki/`, `converted/`, `cache/ast/v*/`, `cache/semantic/`, `manifest.json`, `stat-index.json`, `.graphify_labels.json`, `memory/`, `reflections/LESSONS.md`.

**Indexing** is entirely in-process, lazily built, and cached *on the graph object itself* so a hot-reload that swaps `G` auto-invalidates it:
- `_idf_cache` (`serve.py:281-303`) — per-term IDF, `log(1 + N/(1+df))`.
- `_trigram_index` (`serve.py:336-357`) — `{trigram: array("i") of node positions}` over a NUL-joined concatenation of `norm_label`, tokenized label, node id, `source_file`, tokenized source path (`_node_search_text`, `serve.py:313`). Plus a per-trigram `set_cache` memo.

**Memory vs disk**: whole graph in RAM. The MCP server keeps a `_GraphContextCache` — one *pinned* default graph plus an LRU of up to `GRAPHIFY_MAX_CONTEXTS` (default 8) project graphs, keyed by `(mtime_ns, size)`, with the trigram index warmed at load so the first query doesn't pay build cost (`serve.py:102-163`). The CLI reloads and re-indexes the whole file per invocation. Hard cap 512 MiB per graph file, overridable via `GRAPHIFY_MAX_GRAPH_BYTES` (`security.py:32-65`, enforced at `security.py:357`).

**Optional external stores** are export-only, one-way: `push_to_neo4j` (MERGE-based upsert, `exporters/graphdb.py`), FalkorDB, `to_cypher`, `to_graphml`, Obsidian vault, Canvas, SVG, HTML. Nothing reads back from them.

---

## 5. Query / retrieval engine

All in `graphify/serve.py`. The full pipeline is `_query_graph_text(G, question, *, mode="bfs", depth=3, token_budget=2000, context_filters=None) -> str` (`serve.py:1114`).

**Step 1 — terms.** `_query_terms` (`serve.py:253`): tokenize on `\w+`, jieba-segment Chinese, drop a curated multilingual stopword set (`_QUERY_STOPWORDS`, `serve.py:221-251` — English + German + trimmed Romance, with an explicit collision analysis in the comment: they include `die`/`hat` but deliberately omit `war`/`bald`/`comment`/`come`/`son`). Falls back to unfiltered terms if the query is all stopwords.

**Step 2 — scoring.** `_score_query(G, terms, *, collect_per_term_seeds) -> _QueryScores(ranked, best_seed_by_term)` (`serve.py:439`). Candidate generation via `_trigram_candidates` (`serve.py:360`), which returns **`None` — meaning "fall back to a full scan" — when the index isn't selective** (needle too short to trigram, or its rarest trigram covers >10% of the graph). The guard is postings-length lookups only, no set intersection. This is a *never-worse* contract: results are identical either way.

The scoring formula, per node, with `w = idf[t]`:

```
_EXACT_MATCH_BONUS     = 1000.0     # serve.py:275-278
_PREFIX_MATCH_BONUS    =  100.0
_SUBSTRING_MATCH_BONUS =    1.0
_SOURCE_MATCH_BONUS    =    0.5

# whole-query tier (serve.py:521-529)
joined == norm_label|bare_label|label_tokens|nid   ->  +1000 * 10 * joined_w
joined prefixes any of those                       ->  + 100 * 10 * joined_w
   where joined_w = max(idf[t] for t in terms)

# per-term tiers, strongest tier only per term (serve.py:545-568)
t == norm_label|bare_label       -> tiered += 1000*w ; matched += 1
elif norm_label.startswith(t)    -> tiered +=  100*w ; matched += 1
elif t in norm_label             -> score  +=    1*w ; matched += 1
if t in source_file              -> score  +=  0.5*w          # scores but does NOT count as coverage

# coverage scaling (serve.py:596-597)
score += tiered * (matched / n_terms) ** 2
```

The **squared coverage term** is the interesting bit, and the comment explains why squaring rather than linear: the exact tier is 10× the prefix tier, so at linear coverage a 1-of-10-terms exact match still outscores a 3-of-10 prefix+substring match (`serve.py:530-542`, #1602). Ties break toward the shorter label (`serve.py:600-602`).

**Step 3 — seed selection.** `_pick_seeds(scored, max_k=3, gap_ratio=0.2, *, G, best_seed_by_term)` (`serve.py:633`): take up to 3 seeds, stopping when a score drops below 20% of the top; **dedupe seeds by normalized label** so dozens of `GET`/`handler` nodes can't consume every slot (`serve.py:674-700`, #1766); then **guarantee at least one seed per distinct query term that matched anything**, so one term's incidental exact-match collision cannot starve the others (`serve.py:702-722`, #1445). Relational verbs (`calls`, `uses`, `imports`, …) are stripped from the *guarantee* but keep their place in the ranking, so a symbol genuinely named `calls` can still win on merit (`serve.py:735-745`, `1131-1143`, #2507).

**Step 4 — context filter.** Explicit `context_filter=['call']` or heuristically inferred from question wording (`_CONTEXT_HINTS`, `serve.py:748-755`); `_filter_graph_by_context` builds a node-complete, edge-filtered copy (`serve.py:834-848`).

**Step 5 — traversal.** `_bfs(G, start_nodes, depth)` / `_dfs(...)` (`serve.py:901`, `:932`). Default depth 2 from the CLI (`cli.py:1047`), 3 from MCP. The one real trick:

```python
# serve.py:904-908 — hub gating
degrees_sorted = sorted(G.degree(n) for n in G.nodes())
hub_threshold = max(50, degrees_sorted[int(len(degrees_sorted) * 0.99)])
...
if n not in seed_set and G.degree(n) >= hub_threshold:
    continue   # do not expand THROUGH a hub; a seed hub is still expanded
```

p99-degree-or-50 hub gating prevents the classic "everything is 2 hops from `utils.py`" blowup, while still letting a hub be an answer when it's what you asked about. Then `_complete_induced_edges` (`serve.py:851-898`) repairs the fact that both traversals return a *tree*, not an induced subgraph — seed↔seed edges and hub↔hub cross-edges were missing (#2323). Cost is bounded to edges incident to `visited`, and appends are `sorted()` for hash-seed stability.

**Step 6 — rendering under a token budget.** `_subgraph_to_text(G, nodes, edges, token_budget=2000, *, seeds)` (`serve.py:959`): ~3 chars/token, seeds rendered **first**, then non-seeds ordered by `(hop distance from seeds, -degree, id)` — recomputing BFS layers over both edge directions because `_bfs` returned a set and discarded discovery order (`serve.py:974-998`). Output lines are:

```
NODE {label} [src={source_file} loc={source_location} community={community_name}]
EDGE {src_label} --{relation} [{confidence} context={context}]--> {tgt_label} at={source_file}:{loc}
```

Every LLM-derived field passes through `sanitize_label` before concatenation — explicit prompt-injection defense for MCP output (`serve.py:1001-1005`, F-010). On truncation the notice goes **at the top as well as the bottom**, with counts and a concrete narrowing hint, and the seed block is never cut ("silence used to read as absence", `serve.py:1058-1084`).

**No community summarization, no GraphRAG.** Community detection exists (`cluster.py`) but is used for *reporting and labeling*, not retrieval: `_partition` runs **Leiden via graspologic** (`random_seed=42, trials=1`) falling back to **NetworkX Louvain** (`seed=42, threshold=1e-4, max_level=10`) — `cluster.py:22-77`, on a re-inserted sorted copy of the graph for determinism. Communities >25% of the graph are re-split by a second Leiden pass; communities ≥50 nodes with `cohesion_score < 0.05` are re-split again (`cluster.py:81-84`, `:196-215`). Final IDs are assigned by `(-size, tuple(sorted(nodes)))` — a **total order**, so identical groupings always get identical integer IDs (`cluster.py:217-224`, #1090). Labels are LLM-free by default: `label_communities_by_hub` names each community after its highest-degree member (`cluster.py:86`). `community_member_sigs` fingerprints membership with SHA256 so a later `cluster-only` knows which communities actually changed and must not reuse a stale LLM label (`cluster.py:110`).

**No PageRank.** Betweenness is used only in analysis: `nx.edge_betweenness_centrality` as a fallback for surprises with no community info, hard-capped at 5,000 nodes (`analyze.py:353-359`), and `nx.betweenness_centrality(G, k=..., seed=42)` sampled for question suggestion (`analyze.py:460`). `god_nodes` is plain degree with file/concept/JSON-key/builtin-noise nodes filtered out (`analyze.py:109-130`).

**Ranking of "interesting" edges** — `_surprise_score` (`analyze.py:203-274`) is a small additive rubric: confidence bonus (AMBIGUOUS 3 / INFERRED 2 / EXTRACTED 1) + 2 cross-file-type + 2 cross-top-level-dir + 1 cross-community + 1 peripheral→hub, ×1.5 for `semantically_similar_to`, with all structural bonuses **zeroed** for INFERRED cross-language or code↔doc `calls`/`uses` (known resolver pollution).

**`shortest_path`** is directed by default, `undirected=true` to opt out (`serve.py:1275-1281`, #2487). **`affected`** is a reverse-edge blast-radius BFS over a whitelist of relations (`affected.py:146-207`), seeded with the node's own `method`/`contains` members so a caller bound to a method rather than its class is still reachable (#1669), and reporting the *call-site* location per hop.

**Endpoint resolution** is tiered and honest about ambiguity: `_find_node_tiers` returns `(source_exact, exact, prefix, substring)` (`serve.py:1164`), and `find_node_ambiguity` (`serve.py:1248`) reports rival candidates when the winning tier spans multiple source files instead of silently answering with an arbitrary one.

**Query expansion is delegated to the agent.** The skill's `query.md:23-59` mandates a "constrained query expansion" step: dump the graph's actual label vocabulary to `.vocab.txt`, have the LLM pick **up to 12 tokens from that exact list**, print the selection for auditability, and *stop if nothing matches* — "do not fabricate a search." That is their substitute for embeddings.

---

## 6. BENCHMARKS.md — claims and methodology honesty

**Claims** (`BENCHMARKS.md`, dated 2026-07-05): LOCOMO n=300 recall@10 **0.497** (vs BM25 0.362, mem0 0.048, supermemory 0.149), LOCOMO QA **45.3%** (supermemory 49.7%, BM25 31.3%, mem0 27.3%), LongMemEval-S n=50 **76%** (tied with dense RAG), ingest **~$1.40** vs supermemory $15.67, **$0 LLM credits** to build the graph, ERPNext code suite 70.8%→82.0% key-fact coverage with n=6 questions, 689 weekly AST checkpoints 2011–2026.

**What is genuinely above average:**
- One model for every LLM role (Kimi K2.6), one shared local embedder (BGE-m3) where permitted, identical token budgets, per-run spend ledger with `--max-spend` (`BENCHMARKS.md:99-110`).
- **Judge validation is disclosed**: blind-validated against a second independent judge, 90.6% agreement, Cohen's κ 0.81, and every verdict cites a verbatim quote from the answer (`BENCHMARKS.md:85-97`). Most memory-system benchmarks publish none of this.
- Competitors run as **adapters inside graphify's harness**, so they see the same reader and grader.
- The recall confound is **self-flagged with an asterisk**: supermemory's self-host locks its own 768-d English-only embedder, so its recall number isn't comparable (`BENCHMARKS.md:127-131`).
- Bold marks graphify's config, "not the column maximum" (`BENCHMARKS.md:125`) — and the headline table does not hide that supermemory beats them on QA.
- A **seed-only ablation** (no graph expansion) is reported at 42.7% vs 45.3% (`BENCHMARKS.md:139`).

**Where I'd discount it:**
1. **The harness is not in this repo.** `memory/runner.py` and `crosstool/run.py` (the reproduction commands at `BENCHMARKS.md:180-187`) do not exist here, and neither do the datasets. Nothing in BENCHMARKS.md is reproducible from the artifact you can read.
2. **The benchmarked system is not the system in this repo.** The headline row is "graphify (graph-expand)"; a separate row is "graphify (SurrealDB engine)". Neither a SurrealDB backend nor any embedding/hybrid retriever exists in this codebase — and the README simultaneously advertises "no embeddings, no vector store." The BENCHMARKS summary line reads "graphify's deterministic graph **plus hybrid retrieval**." So the benchmark measures the *commercial platform*, marketed under the OSS project's name.
3. **"$0 LLM credits to build the graph"** is true only for pure-code corpora. LOCOMO is conversational text — i.e. exactly the Pass-3 semantic path — and the row itself lists ~$1.40 of ingest cost. The two claims sit two lines apart.
4. **n is small where the wins are largest.** LongMemEval-S n=50 (a 2-point gap is ~1 question), code suite **n=6 graded questions**, ERPNext lift 70.8%→82.0% on six questions is not a measurement.
5. The temporal suite (`BENCHMARKS.md:141-152`) reports only node/edge/file counts — no accuracy metric — and the narrative claim that "plain lexical retrieval finds less of the answer while graph and semantic retrieval scale with it" is unsupported by any number in the table.
6. The `docs/how-it-works.md:79-91` token-reduction table is honest in a way the README isn't: 71.5× on 52 files, 5.4× on 4 files, **~1× on 6 files** — and `benchmark.py:36` estimates corpus size as `nodes × 50` words when a real word count isn't handed in, which is circular.

**Net:** methodology and disclosure quality are clearly above the norm for this product category; scope honesty (which artifact was measured) is the weak axis.

---

## 7. The clever parts (7 ideas worth stealing)

**7.1 — The single-source-of-truth ID recipe with a written failure history.** `graphify/ids.py` (50 lines) exists solely so three producers can't drift, and its docstring names the four bugs that motivated it. The pattern generalizes: when N independent producers must agree on an identifier, the recipe is a module, not a convention. Idempotency is stated as a contract (`normalize_id(normalize_id(s)) == normalize_id(s)`) and tested (`tests/test_id_normalization_contract.py`).

**7.2 — Tier-scoped replace-on-re-extract (`_origin` + `_is_ast_tier`).** `build.py:43`, `:1599-1648`. Each source file has two independent producers (cheap deterministic, expensive LLM) whose outputs coexist in one graph, and a re-extract of one tier replaces *only that tier's* prior contribution. Legacy items are backfilled with `_origin` at load time via a shape heuristic so the graph self-heals (`build.py:1406-1417`). This is exactly the "cheap parser + expensive enricher" problem, solved cleanly.

**7.3 — Incremental resolution context.** `watch.py:1235-1310`. Instead of re-parsing unchanged files so resolvers can see them, project the *persisted index* back into the resolver as read-only context (nodes + `contains`/`method` edges + callability markers), scoped by three rules and explicitly never emitted from. Cost of an incremental build becomes O(changed files) for parsing and O(index projection) for resolution, without losing cross-file edges.

**7.4 — Trigram prefilter with a never-worse escape hatch.** `serve.py:336-409`. Lazily built, cached on the graph object (so a hot-swap invalidates it for free), returns candidates **in graph-iteration order** so downstream tie-breaks stay byte-identical to a full scan, and returns `None` — "not worth it, do the full scan" — when the rarest trigram of a needle still covers >10% of the graph. The selectivity guard is postings-length lookups only. An index that knows when to disqualify itself is rare and good.

**7.5 — The seeding rules: per-label dedup + per-term guarantee + intent-verb demotion.** `serve.py:633-745`, `:1131-1143`. Three independent failure modes of naive top-k seeding — homonym flooding, one term's incidental exact match starving the others, relation verbs seating decoy roots — each fixed with a small, separately-reasoned rule, and each with its issue number and the counterexample that motivated it. `_pick_scored_endpoint` (`serve.py:609`) adds a fourth: prefer the first score-ordered candidate whose label contains *every* query token, which is what prevents false "No path found."

**7.6 — Budgeted rendering with seed-first ordering and loud truncation.** `serve.py:959-1111`. Rank by hop-distance-from-seed (not degree, not discovery order), never cut the seeds, announce truncation at the *top* with counts and a concrete narrowing action (`context_filter=['call']`, `get_node`, raise `--budget`). The reasoning — "silence used to read as absence" — is the correct framing for an agent consumer that cannot tell an empty answer from a truncated one.

**7.7 — Edge locations are relation *sites*, and answers carry provenance by construction.** `serve.py:1042-1049`, `affected.py:34-42`, `cli.py:1530-1536`. "Who calls X" cites the caller's call line, not the caller's def line. Combined with `EXTRACTED`/`INFERRED`/`AMBIGUOUS` + discrete `confidence_score` on every edge, and `verification="unverified"` flags on unevidenced LLM symbols, every rendered line is independently checkable. **Honourable mention (7.7b):** the write-back memory loop — `graphify save-result --outcome useful|dead_end|corrected` → `graphify-out/memory/*.md` → `graphify reflect` produces `LESSONS.md` with **time-decayed signed scores** and a corroboration threshold before a node is promoted to "preferred" (`reflect.py:1-25`); the resulting overlay is rendered inline in query output as `learning=preferred|contested [code changed since — re-verify]` (`serve.py:1006-1013`). Deterministic, no LLM, and staleness-aware.

---

## 8. The weak parts (what I would not copy)

- **Module gigantism.** `extract.py` is 6,524 lines / 300KB in one file; `cli.py` is 4,214 lines with the entire command set inside one `dispatch_command(cmd)` `if/elif` chain doing manual `sys.argv` parsing (`cli.py:805-4200`); `llm.py` 3,164; `serve.py` 2,290; `install.py` 2,291 for installer logic across 20+ assistant platforms. There is an `extractors/` package with a `MIGRATION.md`, so a split is in progress, but it's a third done.
- **Regression-scar architecture.** Almost every non-trivial function is a stack of narrow special cases annotated with issue numbers (`build.py:1148-1199` alone carries the cross-language phantom-edge drop, the import self-loop drop, and the undirected reverse-duplicate drop). It's admirably documented, but the *rules are the design* — there's no model underneath, so each new corpus shape adds another clause. `deduplicate_by_label` (`build.py:1322`) is even marked "**Dormant**: this is NOT wired into `build()`" — dead code kept in the hot module.
- **Hash-seed/order fragility as a recurring class.** At least six places sort explicitly to defeat CPython string-hash-seed nondeterminism (`build.py:939-942`, `:1068-1071`, `cluster.py:34-45`, `:217-224`, `serve.py:889-891`, `dedup.py:660-666`). Each fix is right; the root cause is keying identity decisions off set/dict iteration in the first place.
- **The whole graph is one JSON file, fully re-read, re-indexed, re-clustered and re-written on every change.** No partial read, no partial write, no incremental clustering. Concurrency is a `flock` plus a pending-changes queue file. `_load_existing_graph` bypasses NetworkX entirely and parses raw JSON (`build.py:1376-1391`) because the round-trip destroys edge direction — a strong signal that NetworkX-as-storage was the wrong choice, worked around rather than replaced.
- **Fuzzy label dedup is a live correctness risk, and they know it.** Jaro-Winkler at 92 with MinHash/LSH prefilter needed *six* separate hard blocks to stop destructive merges (`dedup.py:601-618`), code nodes had to be excluded from label matching entirely (#1205, #1247), and cross-file long labels had to be demoted to plain Jaro (#1243). The `to_json` shrink guard warning even names "fuzzy dedup collapsed same-named symbols across files during an `--update`" as a cause of unexpected node loss (`export.py:276-283`).
- **Retrieval has no semantics.** Case-folded substring + IDF, no stemming, no synonyms, no embeddings — acknowledged in `query.md:25`. The mitigation is to make the *LLM* do vocabulary-constrained expansion at query time, which pushes recall onto prompt compliance and adds a round trip. Magic-number scoring constants (1000 / 100 / 1 / 0.5, ×10 for the joined tier, squared coverage) are tuned by anecdote; `tests/bench_query_scoring.py` measures latency, not relevance.
- **Prompt-driven pipeline orchestration.** The canonical `--update` path is a bash+python heredoc *inside a markdown file* the agent is asked to execute (`skills/claude/references/update.md:86-165`), with placeholders like `IS_DIRECTED` the model must textually substitute. There's a code-generation system (`tools/skillgen`, CI-enforced round-trips) to keep 20 host variants consistent — impressive engineering in service of an architecture that shouldn't need it.
- **Multiplicity of near-duplicate code paths**: `build` vs `build_merge` vs `merge_raw_extraction`; `cli.update` vs `watch._rebuild_code` vs the skill's `--update` runbook; `_bfs`/`_dfs` in `serve.py` vs a third copy in `benchmark.py:37` vs a fourth inlined in `query.md:110-137`. Each pair is documented as "mirrors X exactly so they can't drift," which is the confession.
- **A hook that blocks the agent's file reads** (`--strict`, `README.md:205`) is a product decision I'd avoid: it makes graph staleness a correctness hazard for the *host agent*, not just for graphify.

---

## 9. Fit assessment for specd

Constraints: Postgres-only, derived-from-git, incremental on merge, agent-as-consumer, per-claim citations.

| # | Idea | Fit |
|---|---|---|
| 7.1 | Single-source-of-truth ID recipe (`ids.py`) | **Adopt as-is.** You have ≥3 identity producers already (chunker, wiki-link resolver, embedder keys). A `normalize_id` with NFKC + `re.UNICODE` + casefold, tested for idempotency, is ~30 lines and prevents the exact `[[wiki-link]]`-doesn't-resolve-to-doc class of bug. Postgres-neutral. |
| 7.2 | Tier-scoped replace (`_origin` + per-tier drop) | **Adopt, high value.** Maps directly onto your cheap-vs-expensive split (hash n-gram embedder vs Voyage; parser-extracted structure vs LLM-derived claims). Implement as an `origin`/`tier` column with `DELETE FROM chunks WHERE doc_id = $1 AND tier = $2` — a partial delete keyed on `(source, tier)`, which is a natural Postgres operation and *cheaper* for you than for them. |
| 7.3 | Incremental resolution context | **Adapt.** Your analogue: when re-indexing only the docs changed in a merge, `[[wiki-link]]` and ADR-supersedes edges must still bind to unchanged docs. Do it as a SQL read of the existing node/alias table rather than an in-memory projection — a `SELECT id, title, aliases FROM nodes WHERE doc_id <> ALL($changed)` is the whole feature, and it's the difference between correct incremental linking and quietly dropping cross-doc edges. |
| 7.4 | Trigram prefilter + never-worse guard | **Skip the implementation, adopt the discipline.** Postgres already gives you `pg_trgm` + GIN and a planner that makes this decision. What *is* worth copying is the never-worse contract and the selectivity guard as an explicit, tested property of your hybrid retriever — e.g. assert that adding the lexical arm never removes a result the vector arm alone would have returned. |
| 7.5 | Seed rules: label-dedup, per-term guarantee, verb demotion | **Adopt at the RRF layer.** Your RRF has the same three pathologies: near-duplicate chunks from one doc eating the top-k, one rare query term dominating fusion, and relation verbs ("supersedes", "depends on") matching prose. Per-source-doc dedup before fusion, a guaranteed slot per query concept, and a demotion list are all cheap post-processing on fused results. |
| 7.6 | Budgeted rendering, seed-first, loud truncation | **Adopt verbatim, highest immediate ROI.** An agent drafting specs must never mistake truncation for absence. Rank retrieved context by distance-from-anchor rather than raw score, never truncate the anchor chunk, and emit a top-of-output truncation banner with counts and a narrowing action. Pure formatting; zero infrastructure cost. |
| 7.7 | Relation-site locations + confidence tiers + `unverified` flags | **Adopt — this is your citation model.** Store the *citation site* (doc path + line/anchor of the sentence supporting the claim), not just the containing chunk; tag each retrieved fact `EXTRACTED` (verbatim in source) vs `INFERRED` (derived) vs `AMBIGUOUS`; use a **discrete** confidence rubric rather than a 0–1 range for the exact reason they document. And copy the flag-don't-drop rule for unevidenced LLM output. This is the closest thing in the repo to specd's per-claim-citation requirement. |
| 7.7b | Write-back memory + time-decayed reflection | **Adopt later, fits well.** `save-result`-style outcome feedback is a Postgres table (`retrieval_feedback(spec_id, node_id, outcome, ts)`), the reflection is one windowed query with exponential decay, and the `learning=preferred [stale — re-verify]` overlay maps onto your git-derived index perfectly: mark a lesson stale when the cited doc's commit SHA changed since the feedback. |
| — | Leiden/Louvain community detection | **Does not fit as-built.** They re-cluster the entire graph on every rebuild — unacceptable when you re-index on every merge. If you want community structure, compute it out-of-band on a schedule, or use `remap_communities_to_previous`-style ID stabilization (`cluster.py:262`) so IDs don't churn. Note also that graphify does **not** use communities for retrieval, only for reporting — there's no evidence here that community summarization would help an agent-consumer. |
| — | Single-JSON storage, NetworkX, in-process indexes, `flock` | **Explicitly do not copy.** You already have the better answer. Postgres gives you partial writes, MVCC, transactional prune-and-replace, and index maintenance for free — all things graphify spends thousands of lines reimplementing (`_load_existing_graph`, `to_json` shrink guard, `_rebuild_lock`, `_queue_pending`, stat-index). |
| — | Fuzzy label dedup (MinHash/LSH + Jaro-Winkler @92) | **Do not copy.** Six escape hatches and still a documented cause of silent data loss. If you need entity resolution over ADR titles, use exact-normalized + explicit alias tables and require human/LLM confirmation for anything fuzzy. |
| — | The shrink guard as a *concept* | **Adopt.** A rebuild that would remove rows from sources that were neither re-indexed nor deleted this run should **fail loudly**, not commit. In Postgres this is a cheap assertion inside the same transaction as the swap — and it's the single best defense against a bad webhook or a partial extraction silently gutting your knowledge index. |

---

## 10. Miscellany

**Language / runtime.** Python ≥3.10, no compiled extension of its own. Type hints throughout but `pyright` in `basic` mode over `graphify` + `tests`; `ruff` restricted to a deliberately tiny rule set (`E9, F63, F7, F82` — syntax errors and undefined names only), described in `pyproject.toml:~150` as keeping "the committed baseline conservative."

**Dependency weight.** Core install is **heavy for a "no vector DB" tool**: `networkx`, `numpy`, `rapidfuzz`, plus **26 pinned tree-sitter grammar packages** as hard dependencies (`pyproject.toml:14-42`). Everything else is an extra — 23 of them (`pdf`, `office`, `google`, `video`, `mcp`, `neo4j`, `falkordb`, `svg`, `leiden`, `ollama`, `openai`, `gemini`, `anthropic`, `bedrock`, `azure`, `sql`, `postgres`, `dm`, `terraform`, `pascal`, `chinese`, `all`, `watch`). Notable: **Leiden is optional and Python<3.13 only**; on 3.13+ you silently get Louvain. `graphify/_minhash.py` is a from-scratch, datasketch-compatible MinHash+LSH written specifically to avoid `scipy` — because `datasketch.lsh` imports `scipy.integrate.quad`, which lazily loads `numpy.testing`, which calls `platform.machine()`, which spawns `cmd.exe` and hangs for minutes under corporate EDR on Windows (`_minhash.py:1-11`). That's a real dependency-avoidance decision with a real reason, and it includes a scipy-free numerical integrator for LSH band/row optimization (`_minhash.py:52-79`).

**License.** **Apache-2.0** (`LICENSE`, `pyproject.toml:10`), with `LICENSE-MIT` retained: "Portions of this software were contributed under the MIT License prior to the relicensing and remain available under those terms" (`NOTICE`). Copyright 2026 Safi Shamsi and the Graphify contributors. PyPI package is `graphifyy` (double-y); the README warns other `graphify*` packages are unaffiliated (`README.md:159`). Clean for reading/learning; if you ever vendored code you'd need the Apache-2.0 NOTICE handling.

**Test quality — genuinely strong, the best part of the repo.** 190 test files, 3,626 test functions, 65.9k LOC — **1.6× the source line count**. One file per module plus one per bug class (`test_phantom_cross_package_call.py`, `test_cross_extension_reexport_self_cycle.py`, `test_indirect_call_nested_closure_shadow.py`, `test_semantic_id_remap_root.py`, `test_stale_prune.py`, `test_build_merge_shrink_guard.py`, `test_id_normalization_contract.py`). `conftest.py:9-27` gives **every test a throwaway `HOME`** with `Path.home` monkeypatched and `CLAUDE_CONFIG_DIR`/`XDG_CONFIG_HOME` deleted, so installer tests can never touch a real `~/.claude` (#2168). Pure unit tests, no network, no FS side effects outside `tmp_path` (`ARCHITECTURE.md:82-84`). Dev tooling includes `hypothesis`, `bandit`, `pip-audit`, `pytest-cov`. CI (`.github/workflows/ci.yml`) matrixes 3.10/3.12, runs `uv --frozen` so the lockfile never churns, and gates on five **skillgen validators** (generated-artifact freshness, per-host coverage audit, `file_type`-enum-singleton check, monolith round-trip, always-on round-trip) — an anti-drift system for generated prompt files that also runs as a pre-commit hook. Two non-CI microbenchmarks live in `tests/` (`bench_query_scoring.py`, `bench_extract.py`) with explicit "do NOT wire this into CI (wall-clock assertions are flaky)" warnings.

**AGENTS.md — 8 lines, and the workflow is dogfooding:**

> This project has a graphify knowledge graph at graphify-out/.
> - Before answering architecture or codebase questions, read `graphify-out/GRAPH_REPORT.md` for god nodes and community structure
> - If `graphify-out/wiki/index.md` exists, navigate it instead of reading raw files
> - After modifying code files in this session, run `graphify update .` to keep the graph current (AST-only, no API cost)

They use their own tool as the agent's project memory, and the graph is refreshed by the agent itself after every edit session (AST-only, free). Note what's *absent*: no build/test/lint commands, no code-style rules, no PR conventions — the whole file is "use the graph." The real contributor workflow lives in `README.md:814-863` (uv, `pytest tests/ -q`, branch off `v8`).

**The `worked/` directory** is a **reproducible-evidence directory, and `pyproject.toml:~140` explicitly excludes it from pytest collection** (`norecursedirs`). Five subdirs, each a corpus + its committed real output:

- `worked/example/` — 7-file synthetic pipeline (parser/validator/processor/storage/api + 2 markdown), `raw/` inputs only, README predicts the expected graph shape so you can verify.
- `worked/httpx/` — 6-file synthetic Python library, `raw/` + `GRAPH_REPORT.md` + `graph.json` (144 nodes / 330 links) + a 22KB `review.md`.
- `worked/karpathy-repos/` — nanoGPT/minGPT-style corpus, `GRAPH_REPORT.md` + 120KB `graph.json` (no `raw/` — inputs not redistributed).
- `worked/mixed-corpus/` — the 71.5× token-reduction claim's source corpus; README honestly notes the PNG "is not stored in this repo" and tells you how to reproduce with it.
- `worked/rsl-siege-manager/` — the big one: a real third-party project, 1.99MB `graph.json`, 1.85MB `graph.html`, 59KB `manifest.json`, 36KB `GRAPH_REPORT.md`.

It's the honest half of their benchmarking story: committed inputs and committed outputs you can diff against your own run, in a repo whose headline BENCHMARKS.md numbers are *not* reproducible. Its two costs: ~4MB of committed generated artifacts, and the `graph.json` files bake in the pre-#1504 short node-ID scheme (`worked/httpx/graph.json` has `"id": "client_limits"`, not `worked_httpx_raw_client_limits`), so they're stale relative to the current engine.