# code-graph-rag engine analysis — external research

> status: point-in-time snapshot · analyzed 2026-08-10. Like `specs/`, this is
> a historical record of what was true when it was written — do not update it
> as code-graph-rag evolves; append corrections instead.

**What was analyzed:** [vitali87/code-graph-rag](https://github.com/vitali87/code-graph-rag)
at v0.0.591, commit `234816e` (released 2026-08-10), via a read-only clone.
Python ≥3.12; ~77.7k LOC production against ~254k LOC of tests (3.3 : 1);
14 tree-sitter language specs plus an ast-grep YAML tier; Memgraph store with
optional Qdrant/Milvus vector arms; MIT, solo-maintained.

**Why it exists:** commissioned as benchmarking input for the knowledge
engine's next phase — code-awareness — after
[S-102 — knowledge graph: link-aware retrieval and health](../specs/S-102-knowledge-graph-link-aware-retrieval-and-health.md)
landed the doc graph. Companion to the
[graphify engine analysis](graphify-engine-analysis.md), which informed S-102
itself. Together with a same-day as-built audit of this repo's engine, it
produced the phased improvements plan of 2026-08-10 — foundation repairs,
citation discipline, then a tier-1 **symbol index** (explicitly not a call
graph; §10 below carries the cost evidence for that scoping). The plan
document itself — kept as written, with each item carrying the PR that
delivered it — is archived at
[`docs/improvements-plan.html`](../../docs/improvements-plan.html).

**Citation caveat:** `$CGR/` below denotes the code-graph-rag repository root
at the version above. Every `file:line` reference points into that source
tree — never into this repository.

---

## 0. Shape of the thing, up front

77,691 LOC of production Python (`$CGR/codebase_rag` excluding tests), 254,073 LOC of tests, 8,197 LOC of evals, 6,033 LOC of pure constants. One graph store (Memgraph), one optional vector store (Qdrant/Milvus), 14 tree-sitter language specs plus a YAML tier. The indexer is **100% deterministic — no LLM calls at index time** (verified: no `Agent`/LLM import reachable from `$CGR/codebase_rag/graph_updater.py` or `$CGR/codebase_rag/parsers/*`). The LLM sits entirely on the query side. That single architectural choice is the most important thing this repo has in common with specd, and the reason it's worth reading.

---

## 1. What code-graph-rag IS

A single-maintainer, MIT-licensed, pre-1.0 (`Development Status :: 4 - Beta`, `$CGR/pyproject.toml:9`) CLI + MCP server that parses a multi-language monorepo with Tree-sitter into a Memgraph property graph, then answers natural-language questions by having an LLM emit Cypher against that graph, retrieve source spans, and optionally edit the code (`$CGR/README.md:63-65`, `:96-103`). It is unusually mature for a solo project on the axes that are cheap to measure and unusually raw on the ones that aren't: 688 test files / 6,325 test functions / 13 CI workflows / OpenSSF Best Practices badge / Sigstore+SLSA signed binaries (`$CGR/docs/architecture/security.md:37-39`), against a `run()` orchestration method that is a 200-line ordering-sensitive sequence of ~20 deferred-resolution passes (`$CGR/codebase_rag/graph_updater.py:614-811`). Governance is explicitly maintainer-led with a single lead (`$CGR/GOVERNANCE.md:7,13`), continuity is aspirational — "An emergency contact ... **is being designated**" (`$CGR/GOVERNANCE.md:40`). Release cadence is "a patch release on every merge" (`$CGR/docs/roadmap.md:31`), consistent with v0.0.591. Commercial signals: an enterprise page at code-graph-rag.com selling cloud-hosted and on-prem/air-gapped deployments plus consulting and training (`$CGR/README.md:182-191`), a `funding.json` naming an individual owner (`$CGR/funding.json:4-11`), MCP-registry publication (`$CGR/server.json`). The README carries three HTML comment blocks explaining that the GitHub account is suspended and the canonical mirror is Bitbucket, which strips `<picture>` tags and mis-renders shields (`$CGR/README.md:2-8`, `:12-22`, `:32-36`, `:55-59`) — badges pointing at the GitHub API are commented out, badges pointing at CI/Codecov/Sonar/scorecard are not, and the repo still ships with a `github.com/vitali87` origin. **No published scale target anywhere** — no docs page states nodes/files/minutes; the only hard scale datapoint in the tree is a code comment (`$CGR/codebase_rag/dead_code.py:1-7`) recording that django = 31k dead-code roots and 101k `CALLS` edges, and that the per-root Cypher BFS hit Memgraph's 600s timeout there.

**Contradictions found:**

| Claim | Contradicted by |
|---|---|
| "**A hosted service.** code-graph-rag stays a local-first CLI and SDK" (under *What we do not intend to do*, `$CGR/docs/roadmap.md:29`) | "**Cloud-Hosted Deployment**: Managed cloud infrastructure for both the graph database and the AI agent connection" (`$CGR/README.md:186`) |
| "Supports **11** programming languages" (`$CGR/funding.json:18`, and `$CGR/evals/README.md:1068`) | "Supports **13** programming languages" (`$CGR/docs/architecture/overview.md:17`); "bringing the total to **14** supported languages" (`$CGR/NEWS.md:13`); 14 entries in `LANGUAGE_SPECS` (`$CGR/codebase_rag/language_spec.py:342-659`) |
| Schema doc lists 8 `Resource` kinds (`$CGR/docs/architecture/graph-schema.md:36`) and 25 relationship rows (`:42-67`) | Code defines 12 `ResourceKind`s incl. `ENDPOINT`/`RPC`/`DISPATCH`/`CONTRACT` (`$CGR/codebase_rag/parsers/io_access/constants.py:18-39`) and 25 `RelationshipType`s incl. `EXPOSES`/`RESOLVES_TO` (`$CGR/codebase_rag/constants/graph.py:172-173`), neither of which appears in the schema doc's relationship table |
| `Makefile:12,52-54` runs `git submodule update --init --recursive` to "build grammars" | `$CGR/.gitmodules` is 0 bytes — dead build step; grammars come from PyPI wheels (`$CGR/pyproject.toml:100-114`) |

---

## 2. The graph model

**Authoritative source is code, not docs**: `NODE_SCHEMAS` (`$CGR/codebase_rag/types_defs.py:766+`) and `RELATIONSHIP_SCHEMAS` (`:832+`), typed as `NodeSchema(label, properties: str)` (`:528-530`) and `RelationshipSchema(sources: tuple, rel_type, targets: tuple)` (`:754-757`). These same tuples are rendered into the LLM prompt (`$CGR/codebase_rag/schema_builder.py:9-41`) **and** used to audit the produced graph (`$CGR/codebase_rag/graph_audit.py:21-47`) — one definition, three consumers.

**Node labels (21):** `Project`, `Package`, `Folder`, `File`, `Module`, `Class`, `Function`, `Method`, `Interface`, `Enum`, `Type`, `Union`, `ModuleInterface`, `ModuleImplementation`, `ExternalPackage`, `ExternalModule`, `Resource`, `Pattern`, `CodeSmell`, `SecurityIssue` (`$CGR/docs/architecture/graph-schema.md:11-32`). Core code nodes carry `{qualified_name, name, modifiers[], decorators[], path, absolute_path, start_line, end_line, docstring, is_exported}`; `Method` adds `is_property`, `overrides_external`; `Function` adds `is_macro`; `Module` adds `flow_covered` (`:17-20`).

**Edge types (25):** `$CGR/codebase_rag/constants/graph.py:151-176`. Containment (`CONTAINS_*`, `DEFINES`, `DEFINES_METHOD`), module graph (`IMPORTS`, `EXPORTS`, `EXPORTS_MODULE`, `IMPLEMENTS_MODULE`, `DEPENDS_ON_EXTERNAL`), type graph (`INHERITS`, `IMPLEMENTS`, `OVERRIDES`), call graph (`CALLS`, `REFERENCES`, `INSTANTIATES`), I/O + taint (`READS_FROM`, `WRITES_TO`, `FLOWS_TO`), service graph (`EXPOSES`, `RESOLVES_TO`), findings (`IMPLEMENTS_PATTERN`, `HAS_SMELL`, `HAS_VULNERABILITY`).

**Identity** is a dotted `qualified_name` rooted at the project name: `project.dir.dir.file.Scope.name`. The file→module-parts mapping is per-language and this is where the real work is — Python drops `__init__` (`$CGR/codebase_rag/language_spec.py:22-30`), JS drops `index` (`:51-59`), Rust drops `mod` (`:104-112`), PHP strips a leading `src`/`app`/`lib` (`:115-123`), everything else is the raw path (`:75-80`). C++ `namespace a::b` is rewritten to dotted form so both nesting spellings and the libclang frontend agree (`:151-155`). Nested definitions attach to the *enclosing scope*, not flattened onto the module (`$CGR/docs/architecture/graph-schema.md:87-91`).

**Dedup** is two-layer:
- **Write-time**: one unique constraint + index per label from `NODE_UNIQUE_CONSTRAINTS` (`$CGR/codebase_rag/constants/graph.py:478-480`), applied by `ensure_constraints`/`_ensure_indexes` (`$CGR/codebase_rag/services/graph_service.py:299-357`); every node write is a `MERGE` on that key (`:417-420`). `File`/`Folder` key on `absolute_path`, not relative path, so two same-layout repos in the shared graph don't collapse — with an explicit migration that *purges* graphs written under the old key because merged nodes can't be split (`:310-348`).
- **Collision handling**: when a qualified name is genuinely defined twice (`if has_x(): ... else:`, `@typing.overload`, `try/except ImportError`), the first keeps the plain name and later ones get `@<start_line>`, then `@<line>#<col>` if two definitions share a line (`$CGR/codebase_rag/function_registry.py:69-90`). A `CALLS` edge to an ambiguous name links to **every** variant (`$CGR/docs/architecture/graph-schema.md:99`) — recall over precision, deliberately.
- **Edge dedup**: `MERGE` on `(from, rel, to)`, except relationship types listed in `MERGE_KEY_PROPS_BY_REL` (`$CGR/codebase_rag/constants/graph.py:474-476`) where distinguishing props join the merge key so parallel provenance edges (`FLOWS_TO` with different `via`/`kind`) aren't collapsed; the flush splits a batch by merge-key signature to avoid dropping a prop absent from one row (`$CGR/codebase_rag/services/graph_service.py:520-546`).

**Cross-language identity is one namespace.** Everything shares the schema, so a polyglot monorepo is one graph and Cypher doesn't branch on language. The price: the simple-name fallback in call resolution has to gate on "which languages can legitimately call each other" as a hardcoded set (`$CGR/codebase_rag/parsers/call_resolver.py:35-38` — JS family, C++→C, Scala→Java).

---

## 3. Construction pipeline

**Parsers.** Tree-sitter, 14 `LanguageSpec` entries (`$CGR/codebase_rag/language_spec.py:342-659`). A `LanguageSpec` (`$CGR/codebase_rag/models.py:79-94`) is either declarative node-type tuples or a hand-written tree-sitter query string; `FQNSpec` (`:72-76`) carries `scope_node_types`, `function_node_types`, and two callables `get_name(node)` and `file_to_module_parts(path, root)`. Per-language behavioural quirks that can't be data live in a `BaseLanguageHandler` subclass hierarchy resolved by `lru_cache`'d registry lookup (`$CGR/codebase_rag/parsers/handlers/registry.py:16-34`, base at `handlers/base.py:15-59`) — 9 languages have handlers, the rest fall through to a working default. Per-language deep analysis lives in sibling packages (`parsers/py/`, `parsers/js_ts/`, `parsers/rs/`, `parsers/go/`, `parsers/java/`, `parsers/cpp/`, `parsers/csharp/`, `parsers/dart/`, `parsers/lua/`), each with its own `type_inference.py`.

Three **language-support tiers**, which is the good architecture:
1. **Full tree-sitter spec** — 14 languages, full call graph.
2. **ast-grep YAML tier** — `$CGR/codebase_rag/parsers/ast_grep_tier.py:1-6`. A new language is one YAML file with `functions:`/`classes:`/`imports:` pattern lists using `$NAME`/`$PATH` metavars (`$CGR/codebase_rag/parsers/ast_grep_patterns/ruby.yaml`, 22 lines total). Emits `Module`/`Function`/`Class` + `IMPORTS`. Honest about its ceiling in the module docstring: flat names, no call resolution (`:5-6`).
3. **Hybrid compiler frontends** — libclang layered onto tree-sitter for C/C++ macros and `#include` edges (`$CGR/codebase_rag/graph_updater.py:654-655`, `:673-674`), and a bundled Roslyn tool for C# (`$CGR/codebase_rag/parsers/csharp_frontend/frontend.py`) giving real overload resolution and `INHERITS`-vs-`IMPLEMENTS` classification. Every hybrid fact is *optional*: "Any missing fact degrades to the tree-sitter heuristic for that site" (`$CGR/docs/architecture/graph-schema.md:110`).

**LLM at index time: none.** Confirmed by absence — `graph_updater.py` and `parsers/*.py` contain no agent/LLM references.

**Pass structure** (`$CGR/codebase_rag/graph_updater.py:614-811`):
- Pass 1 — folder/package/file structure (`:649-651`)
- pre-Pass-2 — Roslyn oracle, and libclang in non-hybrid mode (`:654-660`)
- Pass 2 — per-file definitions + imports (`:662-663`)
- 15 named deferred-resolution passes between Pass 2 and Pass 3 (`:665-778`), each carrying a comment explaining why it must run *after* the previous one. Deferred C++ out-of-class methods, C++ containment, hybrid macro-call attribution, Go receiver methods, **registry rehydration** (`:693-694`), hybrid expansion calls, forward declarations, recovery-orphaned ctors, prototypes, C++ inherits, Rust mod-scope arbitration, generic inherits, C++20 module impls, verified `IMPORTS` flush, deferred parent links.
- Pass 3 — call resolution (`:781-782`), then LINQ query-operator edges, override attribution, endpoint emission, route-call endpoints, ast-grep findings (`:784-802`)
- Post — flush, endpoint-resource linking, orphan prune, embeddings (`:805-811`)

**Cross-file call/import resolution** is a ranked cascade in `CallResolver` (`$CGR/codebase_rag/parsers/call_resolver.py`, 2,996 lines) with `resolve_function_call` wrapping `_resolve_function_call` in a protocol-redirect (`:315-335`). Ordered strategies: LEGB enclosing-scope walk (`:365-392`, walks up function scopes only, stops at class or module — correct Python semantics), duplicate-variant scope probing (`:404-418`), JS prototype siblings (`:337-363`), typed-receiver dispatch via per-language type inference, constructor-parameter field binding with MRO walk (`:161-252`), single-implementer interface redirect (`:117-122`), and finally a trie suffix-match fallback. Cross-file `IMPORTS` are **deferred and verified**: an import edge is only emitted if its target resolves against the complete module registry (`:744-771`) — no phantom edges. Rust `crate::`/`super::`/`self::` resolution needs an *arbitration* phase because inline `mod` blocks and files can claim the same qn (`:749`).

**Incremental updates — two mechanisms, and they are very different in cost.**

*(a) `cgr start --update-graph` (batch, this is the good one).* `$CGR/codebase_rag/graph_updater.py:1696-1881`.
- Per-file MD5 hash cache `.cgr_hashes` + a per-directory mtime cache, both stored in the repo working tree (`:1699-1709`).
- **Whole-run no-op fast path**: `_is_already_in_sync()` (`:1601-1640`) stats every cached dir, only diffs dirs whose mtime changed, then stats every file and only rehashes the ones newer than the cache file. Returns early with zero graph writes.
- **Per-file skip**: mtime ≤ cache mtime → skip without hashing (`:1744-1748`); else hash and compare (`:1760-1767`).
- **Change handling**: `remove_file_from_state` clears in-memory registry entries under the module prefix, with an *ownership guard* so another file's inline-mod chain sharing the prefix isn't wrongly deregistered (`:1317-1414`); then `_delete_module_entities` issues `MATCH (m:Module {path}) ... OPTIONAL MATCH (m)-[:DEFINES|DEFINES_METHOD*0..]->(c) DETACH DELETE m, c`, project-scoped (`:1449-1466`, query at `$CGR/codebase_rag/constants/graph.py:356-367`).
- **The two hard-won corrections** (issue #532):
  - *Inbound*: before deleting, capture every `CALLS|REFERENCES|INSTANTIATES|IMPORTS|INHERITS|OVERRIDES` edge from an unchanged file into a changed file, and **restore them verbatim** afterwards (`:1242-1299`). The reasoning at `$CGR/codebase_rag/constants/graph.py:428-431` is the insight: re-resolving diverges from a clean index because resolution is context-sensitive, whereas the stored edges already match one.
  - *Outbound*: rehydrate the function registry, `@property` set, macro set, definition paths, C/C++ spans, module qns, and the `class_inheritance` map (ordered by a persisted `base_index` so multiple-inheritance MRO survives) from the graph itself (`:1064-1150`, `:1182+`; queries at `constants/graph.py:402-455`).
- **Deletions**: `(old_hashes ∪ graph_module_paths) − current_files − unreadable_files` (`:1846-1848`) — union with the graph catches a cacheless rebuild; the `unreadable` exemption prevents a transient EIO from erasing live state. Then a `Folder`/`File`/`Module` orphan sweep against disk (`:2039-2127`) plus `ExternalModule` and `Resource` de-anchoring.
- **Renames** are handled as delete+add by design, with a written rationale: capture is scoped to *re-indexed* files only, because restoring an edge to a vanished module qn would fabricate a phantom node (`$CGR/evals/README.md:210-218`).
- **Parser-change detection**: `compute_parser_fingerprint()` MD5s parser source files + grammar wheel versions + resolved frontend modes (`$CGR/codebase_rag/parser_fingerprint.py:15-42`), stamped only on full builds and *warned* (not auto-invalidated) on mismatch (`$CGR/codebase_rag/graph_updater.py:1588-1599`).
- **Cache-orphan detection**: if the repo-local hash cache exists but the shared graph holds zero modules for this project, drop the cache — otherwise an incremental sync trusts the cache and leaves the project silently empty (`:1549-1586`).

*(b) `realtime_updater.py` (watch mode, this is the bad one).* Debounced watchdog with a hybrid debounce/max-wait (5s/30s defaults) and an injectable `TimerFactory` for deterministic tests (`$CGR/realtime_updater.py:62-113`, `:121-197`). Per event: delete the module subtree, delete the `File` node, clear in-memory state, refresh Rust path caches, re-parse, re-arbitrate Rust mod scopes — and then **`MATCH ()-[r:CALLS]->() DELETE r`** across the entire shared graph followed by a full recompute of every call edge (`$CGR/realtime_updater.py:322-323`, query at `$CGR/codebase_rag/constants/graph.py:372`). One saved file ⇒ O(whole graph) work. The docs admit it: "recalculates all CALLS relationships on every processed change ... may impact performance on very large codebases" (`$CGR/docs/guide/realtime-updates.md:62`).

**Full-rebuild cost profile.** Parsing is **single-threaded**: `_process_files` is a plain serial loop (`$CGR/codebase_rag/graph_updater.py:1806-1833`) with a periodic flush every 500 files (`:1824-1827`, `config.py:306`). The only concurrency is at the write boundary — node/relationship flushes fan out over a 4-worker pool, one connection per label/pattern group (`$CGR/codebase_rag/services/graph_service.py:468-490`, `:592-614`, `config.py:305`). ASTs are held in an LRU bounded at 1,000 entries with a re-parse-on-miss loader so eviction never loses type-inference context (`$CGR/codebase_rag/ast_cache.py:36-47`). No published wall-clock numbers anywhere in the repo.

---

## 4. Storage

**Memgraph is the only live store**, via `pymgclient`/`mgclient` in `MemgraphIngestor` (`$CGR/codebase_rag/services/graph_service.py:86-128`). Deployed as Docker containers managed by `cgr daemon up` — `memgraph/memgraph-mage` + `memgraph/lab` + `qdrant/qdrant`, all bound to `127.0.0.1` by default with an explicit `CGR_STACK_BIND_HOST` escape hatch (`$CGR/codebase_rag/docker-compose.yaml:1-31`). No embedded mode. Docker is a hard prerequisite (`$CGR/README.md:123`).

**Schema/indexes**: one unique constraint + one label-property index per node label, both derived from the same `NODE_UNIQUE_CONSTRAINTS` map (`$CGR/codebase_rag/services/graph_service.py:299-357`). Constraint creation swallows exceptions (idempotency), which also swallows genuine failures (`:305-306`, `:355-356`).

**Memory vs disk**: Memgraph is in-memory with snapshot/WAL persistence to a Docker volume; no container memory limit is set in the compose file. Client-side, every read query is rewritten with `QUERY MEMORY LIMIT 4096 MB` appended (`$CGR/codebase_rag/services/graph_service.py:75-83`, `:650`; `config.py:315`).

**At 100k+ nodes** the repo's own evidence is a retreat from the database: `$CGR/codebase_rag/dead_code.py:1-7` — "the per-root \*BFS Cypher formulation is O(roots × graph) and hit memgraph's 600s timeout on big projects (django: 31k roots, 101k CALLS edges), whereas a multi-source walk over the fetched edges is linear and finishes in milliseconds." `flow_verdict.py:4-6` repeats the pattern verbatim for reachability. So: **the two most valuable graph analyses in the product both fetch the edge list to Python and traverse there.** The graph DB is being used as a fast indexed edge store, not as a traversal engine.

**Other backends**: Qdrant (default) and Milvus for vectors behind a `VectorStore` Protocol (`$CGR/codebase_rag/vector_store.py:75-96`, `:118-143`); JSON export of the whole graph (`$CGR/codebase_rag/services/graph_service.py:660-679`) consumable offline by `GraphLoader`, which builds its own in-memory label/id/property indexes (`$CGR/codebase_rag/graph_loader.py:34-42`); a protobuf codec (`$CGR/codec/schema.proto`) with an offline file-backed ingestor (`$CGR/codebase_rag/services/protobuf_service.py`).

**Portability verdict for specd**: nothing in the model needs a graph DB. Two tables — `code_node(id, label, qualified_name, path, absolute_path, start_line, end_line, props jsonb)` with a partial unique index per label, and `code_edge(from_id, rel_type, to_id, props jsonb)` with `ON DELETE CASCADE` — reproduce it exactly. `MERGE` → `INSERT ... ON CONFLICT DO UPDATE`. `DETACH DELETE` of a module subtree → one `DELETE ... WHERE module_id = $1` inside a transaction, which is *strictly better* than what cgr has (see §9). Bounded traversal → `WITH RECURSIVE ... WHERE depth < k`. `ENDS WITH '.Name'` → an index on `reverse(qualified_name)` with `LIKE reverse($1) || '%'`, or pg_trgm GIN. The 100k-edge client-side BFS they already do is a Python `deque` loop over one `SELECT` — that ports unchanged.

---

## 5. Query/retrieval engine

**NL → Cypher, LLM-generated, regex-validated, no repair loop.**

`CypherGenerator` (`$CGR/codebase_rag/services/llm.py:111-154`) is a dedicated single-turn agent whose system prompt is built from (a) the machine-generated schema text (`$CGR/codebase_rag/prompts.py:80-91` → `schema_builder.py:41`), (b) hand-written Cypher rules (`prompts.py:40-76`), and (c) an injected project-scoping block that hard-codes the active project prefixes into the prompt (`prompts.py:215-241`). A separate, stricter prompt is used for Ollama-class models (`prompts.py:312-388`) — a nice acknowledgement that prompt engineering is model-tier-dependent.

Post-generation the raw output is unfenced/cleaned (`llm.py:31-57`), then three validators run:
- `_validate_cypher_read_only` — regex ban on mutating keywords, whitespace/comment-tolerant multi-word patterns (`:60-86`)
- `_validate_no_unbounded_paths` — rejects `[*]`, `[:CALLS*]`, `[:CALLS*1..]`; requires a numeric upper bound (`:89-97`)
- `_validate_call_procedures` — allowlist of MAGE procedure prefixes (`:100-108`)

**There is no retry/repair on failure.** A validator raising, or an invalid query, propagates to `except Exception` and is re-raised as `LLMGenerationError` (`:152-154`). `retries=settings.AGENT_RETRIES` (`:129`) is pydantic-ai's internal retry, not a Cypher-repair loop. Downstream, `create_query_tool` catches everything and returns a `QueryGraphData` whose `summary` carries the error text (`$CGR/codebase_rag/tools/codebase_query.py:103-126`) — so repair is *agent-mediated* (the orchestrator sees the error and may rephrase), never engine-mediated. A syntactically valid but semantically wrong query returns `[]` and is reported as "no results", indistinguishable from a true negative.

**Traversal patterns** are whatever the LLM writes, steered by the prompt. Notably the prompt pushes algorithmic questions off Cypher entirely and onto MAGE procedures — `nxalg.strongly_connected_components`, `pagerank.get`, `path.expand`, `graph_util.ancestors/descendants`, `betweenness_centrality`, `leiden_community_detection` — with an explicit rationale ("Cypher path patterns enumerate all matches with no memoization, so they OOM on cyclic graphs") and an explicit "when Cypher can't answer, return your best bounded approximation" escape (`$CGR/codebase_rag/prompts.py:49-76`).

**Ranking**: none. Graph results are returned in query order. The only ordering pressure is `LIMIT 50` nagged for in the prompt (`prompts.py:252`).

**Hybrid arm**: yes, but *not fused*. `semantic_code_search` embeds the query with UniXcoder (or OpenAI), ANN-searches the vector store, then does a second Cypher round-trip to hydrate node metadata by id (`$CGR/codebase_rag/tools/semantic_search.py:30-91`). There is **no RRF, no score fusion, no reranking** — the orchestrator LLM is told, in prose, to run semantic search first for intent questions, graph queries for structural ones, and to chain them (`$CGR/codebase_rag/prompts.py:145-176`). Fusion is delegated to the model's judgement. Compared to specd's deterministic RRF + graph expansion, this is a strictly weaker and less reproducible design.

**Token budgeting** is real but coarse: a 500-row cap, then a tiktoken-metered greedy row-wise truncation to 16,000 tokens with a truthful "kept N of M" summary so the model knows it was truncated (`$CGR/codebase_rag/tools/codebase_query.py:51-59`, `$CGR/codebase_rag/utils/token_utils.py:23-53`; caps at `config.py:313-316`). A 60s query timeout (`config.py:316`). ast-grep results likewise append an explicit "truncated at limit" line "without this the agent sees a truncated list and assumes it is complete" (`$CGR/codebase_rag/tools/structural_search.py:17-21`).

**Provenance/citations**: the *retrieval* carries evidence — `get_code_snippet` returns `{qualified_name, source_code, file_path, line_start, line_end, docstring}` (`$CGR/codebase_rag/tools/code_retrieval.py:107-114`), and it resolves the recorded `absolute_path` in preference to a CWD-relative join, guarded by a project-root containment check so a same-named local file can't shadow an indexed node (`:76-88`). The *answer* does not: the orchestrator prompt says "Cite your sources (file paths or qualified names)" (`$CGR/codebase_rag/prompts.py:194`) and that is the entire mechanism. **No per-claim citation extraction, no validation of citations against the retrieved set, no refusal on uncited claims.** This is specd's differentiator and cgr has nothing here.

---

## 6. Agent loop + MCP surface

**MCP tools — 16** (`$CGR/codebase_rag/constants/mcp.py:6-22`): `list_projects`, `delete_project`, `wipe_database`, `index_repository`, `update_repository`, `query_code_graph`, `get_code_snippet`, `surgical_replace_code`, `read_file`, `write_file`, `list_directory`, `semantic_search`, `structural_search`, `structural_replace`, `ask_agent`, `flow_verdict`. Registered with JSON schemas built by hand in `$CGR/codebase_rag/mcp/tools.py:135-435`. `ask_agent` nests the full RAG orchestrator (with its own shell + edit tools) behind a single MCP tool (`mcp/tools.py:440-461`) — an agent-in-an-agent whose inner tool approvals are not surfaced to the MCP client.

**CLI agent tools — 12** (`$CGR/codebase_rag/tools/tool_descriptions.py:8-20`): `query_graph`, `read_file`, `create_file`, `replace_code`, `list_directory`, `execute_shell`, `semantic_search`, `get_function_source`, `get_code_snippet`, `structural_search`, `structural_replace`, `web_search`.

**Code editing is present and is the product's headline feature** (`$CGR/README.md:87`). Three mechanisms:
- `replace_code_surgically` — exact-string match inside the file, then a diff-match-patch round-trip; refuses if the target block isn't found, warns (but proceeds) on multiple occurrences, path-confined by `full_path.relative_to(self.project_root)` (`$CGR/codebase_rag/tools/file_editor.py:210-259`).
- `create_new_file` / whole-file write, path-validated by a `@validate_project_path` decorator, serialized behind an asyncio lock (`file_editor.py:265-284`, `tools/file_writer.py`).
- `structural_replace` — ast-grep pattern rewrite across the repo, with `dry_run` (`$CGR/codebase_rag/tools/structural_editor.py`).

All three are gated: `requires_approval=True` on the pydantic-ai `Tool` (`file_editor.py:302`, `file_writer.py:52`, `structural_editor.py:56`), surfaced as an interactive diff-preview confirmation in the CLI (`$CGR/codebase_rag/main.py:325-407`).

**Shell access** is the most carefully engineered part of the safety layer and also the most brittle. `_parse_command` is a hand-rolled shell tokenizer tracking single/double quotes and backslash escapes to split on `|`, `||`, `&&`, `;` (`$CGR/codebase_rag/tools/shell_command.py:69-127`); `_has_subshell` detects `$(`/backticks outside single quotes (`:48-58`). Each segment is checked against a **command allowlist** (`ls`, `rg`, `cat`, `git`, `echo`, `pwd`, `pytest`, … — `config.py:209+`), a **blocked-command set** (`dd`, `mkfs*`, `fdisk`, `shred`, `wipefs`, … — `constants/security.py:60-72`), **regex danger patterns** applied per-segment and per-pipeline (`constants/security.py:137-146`), and a **resolved-path `rm` check** that rejects targets outside the project root or inside system directories (`shell_command.py:141-165`). Separately, `_requires_approval` (`:230-267`) forces confirmation for anything that isn't a read-only command or a safe `git` subcommand, and for anything containing a redirect operator. **YOLO mode** disables the allowlist (destructive-path screening survives), is off by default, toggled explicitly (`$CGR/codebase_rag/models.py:35-44`; documented at `$CGR/docs/architecture/security.md:31`).

**MCP transport safety**: stdio and StreamableHTTP. HTTP binds `127.0.0.1` by default and **refuses to bind non-loopback without `MCP_HTTP_AUTH_TOKEN`** (`$CGR/codebase_rag/mcp/server.py:207-218`); with a token, bearer auth fronts the mount even on loopback, compared with `secrets.compare_digest` (`:220-256`).

**Prompt-injection defenses: effectively none.** This is the weakest part of the safety posture and it is not acknowledged in the security doc (`$CGR/docs/architecture/security.md` has no injection section). Concretely:
- `.cgr.md` **from the analysed repository** is read and concatenated directly into the orchestrator's *system prompt* (`$CGR/codebase_rag/config.py:492-501`; injection site `$CGR/codebase_rag/prompts.py:200-207`). The only mitigation is the prose sentence "if they conflict with the critical rules, the critical rules win."
- File contents, graph rows, ast-grep matches, and DuckDuckGo HTML-scrape results (`$CGR/codebase_rag/tools/web_search.py:28-36`) all return to the model as untagged text with no provenance delimiter.
- The same loop holds `write_file`, `replace_code`, `structural_replace`, and `execute_shell`. Approval is the only barrier, and approval fatigue is the known failure mode.

A hostile repo's `.cgr.md` is a direct system-prompt write. If specd ever indexes an untrusted repo's docs into a prompt, do not copy this.

---

## 7. benchmarks/, evals/, codec/, optimize/, cgr/ — and how honest they are

### `benchmarks/` — micro-benchmarks, honest, narrow
10 scripts (`bench_trie.py`, `bench_ast_cache.py`, `bench_file_hashing.py`, `bench_pathlib_vs_string.py`, `bench_json_serialization.py`, `bench_embedding_cache.py`, `bench_graph_loader.py`, `bench_string_ops.py`, `bench_find_ending_with_fix.py`, `bench_dropin_replacements.py`) + `run_all.py`, with committed timestamped outputs in `$CGR/benchmarks/results/`. Methodology stated: 3 warmup runs discarded, 20–100 measured iterations, median/mean/stddev/min/max/p95, sized to the profiled workload (`$CGR/docs/reports/BENCHMARK_REPORT.md:3-11`). The report cross-checks measured against previously *projected* numbers and says so (`:32-34`, `:57-59`). **These are honest and reproducible — but they benchmark Python data structures, not the system.** There is no end-to-end indexing-throughput or query-latency benchmark anywhere in the repo.

### `evals/` — the strongest thing in the repo, with one structural flaw
43 modules, 11 native oracle programs (`$CGR/evals/oracles/`), a 1,156-line README, committed result CSVs and diff JSONs (`$CGR/evals/results/`).

*What's genuinely good:*
- **Independent oracles per language**, not self-comparison: Python `ast` (`$CGR/evals/ast_oracle.py`), Go `go/parser`+`go/ast`, Rust `syn`, TypeScript/JavaScript via the TS compiler API, Java via the JDK Compiler Tree API, C# via Roslyn, C/C++ via libclang, PHP via `php-parser`, Lua via `luaparse`, Scala via `scalameta` (`$CGR/evals/README.md:925-1043`, `:396-903`). Each oracle emits records already in cgr's `NodeLabel` vocabulary and joins on `(kind, file, start_line)`.
- **Fair-file-set discipline**: the oracle drops records under cgr's own `IGNORE_PATTERNS` so both sides grade the same files — "single source of truth, no drift" (`$CGR/evals/README.md:939`).
- **An execution-traced ground truth (L3)** via `sys.settrace`, explicitly described as a *sound lower bound* (`:74`), with a documented decorator-wrapper normalization applied *in the eval, not in cgr*, so the graph stays clean (`:77-90`).
- **An incremental-correctness eval whose oracle is a clean full re-index** (`:153-218`) — exactly the property specd cares about — run over a faithful in-memory store that executes the real delete Cypher rather than mocking it (`:172-180`).
- **Corrections against itself, published**: oracle over-counts (`from __future__ import`), oracle scope errors (nested test classes, MRO-decided overrides) are documented as *oracle* bugs rather than reported as tool wins (`:1121-1124`, `:1136-1140`).
- **Debunking a widely-repeated third-party claim**: "That work item, contrary to a widely repeated claim, contains no '8% over grep' figure" (`:98-100`).
- **Declaring what's out of scope**: agentic SWE-bench-style resolved-rate is explicitly not run (`:1150-1156`); semantic search is graded as "a regression guard ... not a broad relevance benchmark" (`:919-923`).

*The structural flaw:* **the default and reported target is cgr's own codebase.** `$CGR/evals/cli.py:22-24` defaults `--target` to `codebase_rag`, and the committed results (`$CGR/evals/results/scores.csv`) are **1.0000 precision/recall/F1 on every node and edge label**, with 6800/6800 exact end-line spans. A parser scored against its own source, with per-language quirks that were *fixed in response to this eval*, is measuring fit to a single corpus. The honest numbers are the external ones, and they're much lower and much more informative:
- Retrieval on `codebase_rag`: graph P=0.846 / R=0.989 / F1=0.912 vs grep_call F1=0.536, grep_name F1=0.381 (`$CGR/evals/results/retrieval_scores.csv`, tabulated at README `:1076-1080`).
- Retrieval on `django/django` (~2,900 files): P=0.977 / R=0.938 / F1=0.957 (`$CGR/evals/README.md:139-140`) — the single most credible number in the repo, and notably it isn't the headline.
- Incremental vs clean re-index, **n=25** neutral edits: CALLS P=0.9998/R=0.9978, IMPORTS ~1.0, and — the number that matters — **only 10 of 25 edits reproduce a clean re-index exactly** (README `:1101-1102`). Before the fix it was 3/25.
- L3 traced-call recall: **n=634** traced calls, recall 1.0 (`:1067`). Small n, self-target, fixture-driven.

*Reproducibility from this repo:* Python-only evals run with `uv run python -m evals.cli` and need nothing external. Multi-language L1/retrieval evals need `go`, `cargo`, `dotnet`, `node`, `php`, `lua`, `scala`, and `libclang` on PATH; each exits cleanly if its toolchain is missing. Semantic-search eval needs the `semantic` extra (torch). Retrieval eval needs `rg`.

### `codec/` — protobuf graph serialization
`$CGR/codec/schema.proto` (7.7 KB) + generated `schema_pb2.py`/`.pyi`. A flattened, ID-referenced encoding of the same node/edge model, with the design reasoning written as a 50-line comment block in the `.proto` itself (`:9-60`) explaining why a literal nested tree would duplicate and why child-ID lists are the answer. Consumed by `$CGR/codebase_rag/services/protobuf_service.py` as an offline file-backed ingestor (used by `optimize/profile_io.py`). Excluded from ruff and ty (`$CGR/pyproject.toml:134,161`).

### `optimize/` — a profiling scratch directory, and a licensing problem
`memory_profile.py` (tracemalloc over the parsing pipeline, 22 KB, requires no external services) + `profile_io.py` (I/O/hashing/serialization timing) + `memory_profile_results.json`. Also `code_to_text.sh`, a codebase→single-text-file flattener for feeding an LLM. And then: **`EXPERT_PYTHON_PROGRAMMING_FOURTH_EDITION.pdf` — a 7.8 MB commercial copyrighted book checked into an MIT-licensed public repository**, alongside `tree-sitter.txt` (2.2 MB) and `tree-sitter-cpp.txt` (344 KB), which are flattened source dumps of third-party projects. These exist as "reference documents" for the `cgr optimize` flow (`$CGR/codebase_rag/prompts.py:410-424` takes a `{reference_document}`). The whole directory is excluded from ruff, ty, and bandit (`$CGR/pyproject.toml:134,161,210`). This is a real legal defect, not a style nit.

### `cgr/` — the public SDK facade
14 lines. Re-exports `CypherGenerator`, `GraphLoader`, `MemgraphIngestor`, `embed_code`, `load_graph`, `settings` (`$CGR/cgr/__init__.py:1-14`). That's the entire "Python SDK" the docs advertise as a stability surface (`$CGR/docs/roadmap.md:23`). Shipped as its own top-level package (`$CGR/pyproject.toml:75`).

---

## 8. The clever parts — 7 ideas worth stealing

**(1) The index is deterministic; the LLM lives only at the query boundary.**
No LLM reachable from `$CGR/codebase_rag/graph_updater.py`. Everything semantic — call resolution, type inference, taint, endpoint matching — is a deterministic program with named fallbacks. *Why it's good*: the index is reproducible, diffable, testable against oracles, and free. Every LLM-at-index-time system loses all four. This is the same bet specd made and it's validated here at 14× the language surface.

**(2) Capture groups enforced at the sink, not at the ~20 emission sites.**
`CaptureSelection` resolves a left-to-right token spec (`none`/`all`/`+group`/`-rel`) into a frozenset of enabled relationship types, then derives the enabled node labels from which groups own them (`$CGR/codebase_rag/capture.py:37-115`). A `FilteringIngestor` wraps the real ingestor and silently drops disabled nodes/edges — "so the ~20 parser emission sites stay untouched" (`$CGR/codebase_rag/services/filtering.py:9-36`). A module-level guard enforces that every `RelationshipType` belongs to exactly one group so a new edge type can't escape the model (`$CGR/codebase_rag/constants/graph.py:188-190`). Expensive analyses (`io`, `findings`) are off by default (`:254-261`). *Why it's good*: cost/fidelity becomes one config knob rather than 20 scattered `if` statements, and the decorator pattern makes it impossible to forget.

**(3) A parser fingerprint as a second cache key.**
"A graph is a function of (source files, parser code, parser config). The incremental hash cache keys only the source files" (`$CGR/codebase_rag/parser_fingerprint.py:1-6`). The fingerprint MD5s parser source, pinned grammar wheel versions, and the *resolved* frontend modes — resolved, not configured, because `CSHARP_FRONTEND=auto` produces different edges depending on whether `dotnet` is present (`:32-42`). Stamped only on full builds, because re-stamping after an incremental run would silence the warning while unchanged files still carry old-parser edges (`$CGR/codebase_rag/graph_updater.py:1874-1881`). *Why it's good*: it names the actual invalidation domain instead of pretending content hashing is sufficient. Almost every incremental indexer gets this wrong.

**(4) Capture-and-restore inbound edges verbatim, rather than re-resolving them.**
`$CGR/codebase_rag/graph_updater.py:1242-1299`, with the reasoning at `$CGR/codebase_rag/constants/graph.py:426-431`: "Re-resolving the callers instead would diverge from a clean index, because cgr's call resolution is context-sensitive (protocol vs concrete receiver, import granularity); **the original edges already match a clean re-index**." Restoration is conditional on the target still existing in the registry, so renamed-away targets correctly lose their inbound edges (`:1286-1287`). *Why it's good*: it's the correct answer to a problem most incremental graph builders don't even notice, it's cheap, and it was **discovered by an eval whose oracle is a clean rebuild** — the methodology and the fix are inseparable.

**(5) Rehydrating derived resolution context from the persisted graph.**
An incremental run reads back every definition qn+label, the `@property` set, the macro set, definition file paths, C/C++ spans, module qns, and the full `class_inheritance` map ordered by a **persisted `base_index`** so multiple-inheritance MRO order survives (`$CGR/codebase_rag/graph_updater.py:1064-1150`; queries `$CGR/codebase_rag/constants/graph.py:402-455`). The failure policy is precise: a read failure aborts an incremental run but is only warned on a full build, because a full build re-parses everything anyway (`:1077-1085`). *Why it's good*: it treats the store as the durable half of the analyser's working set. The alternative — keeping enough in memory to resolve — is what forces everyone else into full rebuilds.

**(6) Three-valued reachability: FOUND / NO_FLOW / UNKNOWN, with named coverage gaps.**
`$CGR/codebase_rag/flow_verdict.py:1-6`, `:50-94`. "An empty flow result is ambiguous: 'no flow exists' and 'the flow sits outside what the analysis covers' look identical, and **for assurance questions an absent path must never read as a PASS**." Every `Module` carries a `flow_covered` boolean; if BFS finds nothing *and* any module is uncovered, the answer is `UNKNOWN` with the uncovered file list attached (`:86-94`). Coverage is read project-wide, not reachable-surface-only, because without path sensitivity a flow through an uncovered file can't be ruled out (`:55-57`). *Why it's good*: this is the single most transferable idea in the repo for a spec-drafting agent. It is exactly the discipline a per-claim citation validator needs — "I found no evidence" and "no evidence exists" are different answers and only one of them is safe to write into a spec.

**(7) One schema definition; three consumers.**
`NODE_SCHEMAS` / `RELATIONSHIP_SCHEMAS` as typed tuples (`$CGR/codebase_rag/types_defs.py:766+`, `:832+`) feed (a) the LLM prompt via `schema_builder.build_graph_schema_text()` (`$CGR/codebase_rag/schema_builder.py:35-41`), (b) the structural audit that validates the produced graph against orphans, missing required properties, undocumented labels, and undocumented `(source, rel, target)` triples (`$CGR/codebase_rag/graph_audit.py:21-47`), and (c) the docs, regenerated into marked README/doc sections by `scripts/generate_readme.py` as a pre-commit hook (`$CGR/Makefile:92`, section markers at `$CGR/docs/architecture/graph-schema.md:116-131`). *Why it's good*: the prompt cannot drift from the schema, the graph cannot drift from the prompt, and the docs cannot drift from either. (It's also why the drift that *did* occur — `EXPOSES`/`RESOLVES_TO`, §1 — is confined to a hand-maintained markdown table rather than the generated sections.)

**Honourable mentions**: the three-tier language architecture where a new language is one YAML file (`$CGR/codebase_rag/parsers/ast_grep_tier.py:1-6`); the "cache is orphaned if the shared graph has zero modules for this project" check (`$CGR/codebase_rag/graph_updater.py:1549-1586`); native per-language eval oracles; the deliberate choice to fetch edges and BFS in Python rather than fight the graph engine (`$CGR/codebase_rag/dead_code.py:1-7`); truncation that *announces itself* to the model (`$CGR/codebase_rag/tools/structural_search.py:17-21`).

---

## 9. The weak parts — what I would not copy

**(1) Watch mode is O(whole graph) per file save.** `MATCH ()-[r:CALLS]->() DELETE r` then full recompute, on every debounced event (`$CGR/realtime_updater.py:322-323`). It also deletes CALLS for *every other project* in the shared graph. Documented as a known issue (`$CGR/docs/guide/realtime-updates.md:62`) but shipped as the advertised real-time feature. specd's per-doc-hash incremental-on-merge model is already the right answer; do not regress toward this.

**(2) No transactions.** `conn.autocommit = True` (`$CGR/codebase_rag/services/graph_service.py:225`). The incremental path is delete-subtree → re-parse → re-insert → restore-inbound, and each step auto-commits independently. A crash or an exception between the delete and the restore leaves a permanently half-deleted graph with no rollback and no marker. There is **no shrink guard** — nothing aborts a run that would delete an implausible fraction of the index. The orphan pruner deletes on `not (repo_path / path).exists()` (`$CGR/codebase_rag/graph_updater.py:2086`); the guards are ownership guards (abs-path containment, qn prefix, `read_failed` short-circuit at `:2110-2114`), not magnitude guards. A stale or partially-mounted repo path prunes everything. specd's shrink-guard-on-destructive-transaction is strictly better and should stay.

**(3) A dead memory safety valve.** `BoundedASTCache._should_evict_for_memory` computes `sum(sys.getsizeof(v) for v in self.cache.values())` where each `v` is a 2-tuple `(Node, language)` (`$CGR/codebase_rag/ast_cache.py:86`). `sys.getsizeof` on a 2-tuple returns ~56 bytes regardless of what the tuple points at, so the measured "cache size" is ~56 × entries ≈ 56 KB at the 1,000-entry cap, against a 500 MB threshold (`config.py:308-309`). **The memory bound can never fire.** Only the entry-count cap does anything. On a repo with large files this is the difference between a bounded and an unbounded cache.

**(4) mtime-trust can silently rot the index.** A cached file whose mtime is ≤ the hash-cache file's mtime is skipped *without hashing* (`$CGR/codebase_rag/graph_updater.py:1744-1748`, and the same shortcut in `_is_already_in_sync` at `:1636-1637`). Archive restores, `touch -d`, rsync `--times`, container layer copies, and clock skew all produce content changes with non-advancing mtimes. specd's per-doc content hash with no mtime shortcut is safer; if you ever add an mtime fast path, gate it on a monotonic index generation counter rather than a file's mtime.

**(5) Self-scored evals.** All-1.0 results on the tool's own source (`$CGR/evals/results/scores.csv`, `$CGR/evals/cli.py:22-24`). The external numbers exist and are good; they just aren't the headline. If specd builds an eval harness, make the *external* corpus the default target and the self-target the smoke test.

**(6) Complexity that has outrun its model.** `call_processor.py` 7,618 lines, `import_processor.py` 3,847, `call_resolver.py` 2,996, `graph_updater.py` 2,309. `run()` (`:614-811`) is a hand-ordered sequence of ~20 passes where nearly every one carries a comment of the form "must run after X because Y" (`:665-667`, `:669-672`, `:684-686`, `:696-697`, `:700-703`, `:713-716`, `:723-724`, `:734-735`, `:740-743`, `:773-775`, `:784-785`). This is a fixpoint computation implemented as a manually topologically-sorted script. It works — the evals prove it — but the maintenance surface is enormous and every new language adds edges to that ordering graph. The honest read: cgr has a very good *heuristic pile* for cross-file resolution, not a semantic model. A team without 254k lines of tests cannot maintain this shape.

**(7) LLM at the wrong layer for query planning.** NL→Cypher with regex-only validation and no repair loop (`$CGR/codebase_rag/services/llm.py:80-154`) means correctness of retrieval depends on model quality per query, and a wrong-but-valid query is indistinguishable from an empty result. There is no query-shape template library, no schema-aware validation (nothing checks that `(:Module)-[:DEFINES_METHOD]->` is even a legal triple, despite `documented_relationship_triples()` existing at `$CGR/codebase_rag/graph_audit.py:40-47`), and no ranking. specd's deterministic hybrid retrieval + RRF + bounded graph expansion is a better place to spend the reliability budget.

**(8) No per-claim citation discipline.** Prompt-level "cite your sources" only (`$CGR/codebase_rag/prompts.py:194`). Nothing validates that a cited path was actually retrieved.

**(9) Prompt-injection surface, unacknowledged.** `.cgr.md` from the analysed repo → system prompt (`$CGR/codebase_rag/config.py:492-501` → `prompts.py:200-207`), untagged tool output, web search, and write/shell tools in one loop.

**(10) The C# default runs the analysed repo's build.** `CSHARP_FRONTEND=auto` → `dotnet restore` on the target project (`$CGR/codebase_rag/parsers/csharp_frontend/frontend.py:260-267`) plus a Roslyn compilation in which the repo's own source generators execute (`:376`). Credit where due: `$CGR/docs/architecture/security.md:23` states this plainly, including that it is the default and how to turn it off. But "indexing runs the target's build" is a default nobody should ship.

**(11) A copyrighted commercial PDF in an MIT repo** (`$CGR/optimize/EXPERT_PYTHON_PROGRAMMING_FOURTH_EDITION.pdf`, 7.8 MB), plus 2.5 MB of third-party source dumps, in a directory excluded from every linter.

**(12) Dependency weight.** The `semantic` extra pulls `torch` + `transformers` + ~14 `nvidia-*` CUDA packages (`$CGR/uv.lock`) to run a 768-dim UniXcoder encoder locally. That's multiple GB for an embedding step. specd's hash-based n-gram default embedder is the right instinct.

**(13) Supply chain**: two tree-sitter grammars are pinned to the maintainer's *personal GitHub forks* by git rev (`$CGR/pyproject.toml:70-72`) — on an account the README says is suspended.

---

## 10. Fit assessment against specd's constraints

Constraints assumed: **Postgres-only** (Memgraph is a hard no), derived-from-git, deterministic at index time, incremental on merge, agent-as-consumer, per-claim citations.

| # | Idea | Fit | Notes / Postgres port |
|---|---|---|---|
| 1 | Deterministic index, LLM only at query time | **Already yours.** | Confirms the bet; the interesting delta is that cgr proves it scales to 14 languages of *semantic* extraction, not just link extraction. |
| 2 | Capture groups + sink-side filtering | **Strong fit, adopt.** | Wrap specd's indexer sink in a `FilteringWriter` keyed by link-kind (`wikilink`/`citation`/`mdlink`/`pathref`, and later `code`), so kinds become one config token instead of scattered conditionals. Pure application code, no store dependency. |
| 3 | Parser/extractor fingerprint as a second cache key | **Strong fit, adopt now.** | specd's per-doc hash skip has the identical blind spot: change the chunker, embedder, or link-extractor and unchanged docs keep old-generation rows. Store a `extractor_fingerprint` column on the index-generation row; on mismatch, force a full reindex (or at minimum warn loudly, as cgr does at `graph_updater.py:1588-1599`). |
| 4 | Capture-and-restore inbound edges verbatim | **Fits, and matters more once code links exist.** | Today specd's link extraction is deterministic and context-free, so re-extracting an unchanged doc's outbound links is exact and this is unnecessary. The moment resolution becomes context-sensitive (a doc→code link resolved against a symbol table), the divergence cgr hit appears. Postgres makes it easier: `DELETE FROM knowledge_links WHERE src_doc = $1` inside the same transaction as the reinsert — no capture needed, because you never lose the inbound rows in the first place (they're keyed by the *other* doc). This is a case where Postgres's relational model is strictly better than a graph DB's `DETACH DELETE`. |
| 5 | Rehydrating resolution context from the store | **Fits.** | For code-aware specd: on an incremental merge, `SELECT qualified_name, kind, path FROM code_node WHERE repo = $1` to rebuild the symbol table for files you didn't re-parse. This is one indexed scan in Postgres; cgr does exactly this against Memgraph. Copy the failure policy too (`graph_updater.py:1077-1085`): a rehydration read failure must **abort** an incremental run, never degrade it silently. |
| 6 | Three-verdict FOUND / NO_FLOW / **UNKNOWN** + coverage gaps | **Highest-value adoption. Adopt immediately, independent of code-awareness.** | Direct analogue: a SpecAgent claim whose supporting citation isn't in the retrieved set should resolve to `UNSUPPORTED` vs `UNKNOWN(coverage gap)` vs `CONTRADICTED`. specd already has the ingredients — orphan docs and broken links are exactly a coverage signal. Add a per-doc `indexed_ok`/`coverage` flag (cgr's `flow_covered`, `$CGR/codebase_rag/flow_verdict.py:86-94`) so "no citation found" can be reported as "no citation found **and** these 4 docs failed to index" rather than as a clean negative. |
| 7 | One schema definition → prompt + audit + docs | **Strong fit, adopt.** | specd's link kinds, edge-kind weights, and chunk provenance fields should be one Python/TS constant table that generates (a) the SpecAgent's retrieval-schema prompt block, (b) an index-integrity audit, (c) the docs. cgr's own drift (§1) shows what happens to the *hand-maintained* table when the generated ones are fine. |
| — | ast-grep YAML language tier | **Fits, and is the right first step for code-awareness.** See below. |
| — | Native per-language eval oracles | **Fits.** Language-independent methodology; the analogue is grading specd's link resolution against an independent markdown-link parser rather than against itself. |
| — | Client-side BFS over a fetched edge list | **Fits perfectly — Postgres is *better* here.** cgr retreated to client-side BFS because Memgraph timed out at 101k edges (`$CGR/codebase_rag/dead_code.py:1-7`). specd's 1-hop RRF expansion is already a bounded join; if you ever need k-hop, `WITH RECURSIVE ... WHERE depth < k` on an indexed `(src_doc, kind)` handles 100k edges comfortably, and unlike Memgraph it participates in your transaction. **The scale story here is an argument *for* Postgres, not against it.** |
| — | MAGE graph-algorithm procedures | **Does not port.** No Postgres equivalent for PageRank/Leiden/SCC. But specd doesn't need them: hub-threshold + edge-kind weights already approximate the centrality signal deterministically, which is better for a citation-validating consumer than a global PageRank you'd have to explain. |
| — | Memgraph, Qdrant, Docker daemon, `cgr daemon up` | **Hard conflict. Do not port.** | Nothing in the node/edge model requires a graph DB (§4). The operational burden — three containers, unauthenticated by default, an in-memory store with no memory cap, a `--clean` that wipes every project (`$CGR/README.md:136-140`) — is the whole reason specd's Postgres-only constraint is correct. |
| — | LLM→Cypher | **Do not port.** No query language to generate; specd's retrieval is a fixed pipeline. If you ever expose a structured-query tool to the SpecAgent, template it and validate against `documented_relationship_triples()`-style legality, don't free-generate. |
| — | Agentic file editing + shell in the retrieval loop | **Do not port.** specd's consumer drafts specs; it should not hold write tools. cgr's approval machinery (`$CGR/codebase_rag/tools/shell_command.py:69-267`) is well-built and entirely unnecessary for you. |
| — | `.cgr.md` from the analysed repo → system prompt | **Actively avoid.** (`$CGR/codebase_rag/config.py:492-501`.) If specd ever lets a repo contribute instructions, put them in a *user* turn with an explicit untrusted-content delimiter, never the system prompt. |

### What specifically informs a **code-aware specd**

This is the part worth planning around. Five concrete lessons, in order of leverage:

**A. Stage it as tiers, and make tier 1 cheap and boring.** cgr's three-tier structure (`$CGR/codebase_rag/parsers/ast_grep_tier.py:1-6` vs `language_spec.py:342-659` vs `csharp_frontend/`) is the reusable architecture. For specd, **tier 1 is not a call graph — it's a symbol index**: `(repo, path, kind, qualified_name, start_line, end_line, is_exported)` extracted by tree-sitter with a per-language declarative spec, and nothing else. That alone gives you doc↔code linking (`pathref` links resolving to real files, and a new `symbolref` kind resolving `[[UserService.authenticate]]` to a real node with a file:line), spec grounding ("this ADR references three symbols; two exist, one was deleted in commit X"), and link-health for code (`broken code reference` joins `broken wikilink` as a signal). Tier 2 (imports/inherits) is a modest increment. **Tier 3 — call resolution — is where cgr spent 14,000 lines and it is not required for spec grounding.** The 15-pass deferred-resolution sequence in `graph_updater.py:665-778` exists almost entirely to serve `CALLS`. Skip it.

**B. Node identity is the whole design, and it's the part cgr got right.** A dotted `project.path.Scope.name` with per-language file→module rules (`$CGR/codebase_rag/language_spec.py:22-30, 51-59, 104-112, 115-123`) plus explicit collision variants (`function_registry.py:69-90`). Adopt this shape verbatim. In Postgres it's a `code_node.qualified_name text` with a unique index per `(repo, kind, qualified_name)`, plus `reverse(qualified_name)` btree for suffix matching (cgr's `find_ending_with`, which their own benchmark shows is the #1 hot path at 48.3% of CPU when unindexed — `$CGR/docs/reports/BENCHMARK_REPORT.md:15-30`). **Learn from their benchmark and index the suffix from day one.**

**C. Doc↔code links are the same table you already have.** `knowledge_links` already carries `kind` + resolved/unresolved states. Add kinds `coderef` (a doc mentioning a symbol) and `pathref→resolved` (a doc mentioning a file that exists at HEAD), pointing at `code_node.id` instead of `doc.id` via a polymorphic target. Then 1-hop graph expansion after RRF works unchanged — a chunk citing `UserService` pulls in the symbol's neighbours with `via:'graph'` provenance, exactly as today. **Edge-kind weights become the tuning surface**: a `coderef` to a symbol that still exists should weigh more than one to a deleted symbol, and a symbol touched in the same PR as the doc should weigh more still. cgr has no analogue of this because it has no docs; it's specd's genuine advantage.

**D. Code nodes must carry a git-derived staleness signal, and cgr shows the failure if they don't.** cgr's `absolute_path` + `start_line`/`end_line` retrieval (`$CGR/codebase_rag/tools/code_retrieval.py:76-104`) reads from *disk at answer time*, which means a snippet can silently disagree with the indexed span. For specd, where git is the source of truth and the index is derived, store the **blob SHA and the commit SHA** on every `code_node`, and make a citation to a symbol whose blob has changed since indexing a first-class `STALE` verdict — which folds directly into idea (6). This is the doc↔code equivalent of cgr's parser fingerprint: the claim "spec S is grounded in function F" has a validity window, and the window is a git range.

**E. Incremental cost is a git-diff problem, not a filesystem problem.** cgr walks the tree and hashes (`graph_updater.py:1642-1694`) because it has no git dependency. specd is already derived-from-git, so the changed-file set on merge comes from `git diff --name-status base..head` for free — no hash cache, no dir-mtime cache, no mtime-trust bug (§9.4), and rename detection comes free from `git diff -M`, which is precisely the case cgr explicitly gives up on (`$CGR/evals/README.md:210-218`). **specd's incremental cost profile for code can be strictly better than cgr's**, because git tells you what changed and Postgres gives you a transaction to change it in. The one thing you must copy is (5): rehydrate the symbol table for unchanged files before resolving links in changed ones, or a doc referencing an untouched symbol will lose its edge on every merge.

**Rough cost estimate to reach tier 1:** the reusable core is `LanguageSpec` + `FQNSpec` + a combined tree-sitter query per language (`$CGR/codebase_rag/parser_loader.py:310-357`) + the trie/suffix registry. In cgr those are ~1,600 lines (`language_spec.py` 675 + `models.py` 116 + `function_registry.py` 284 + `parser_loader.py` 494) for 14 languages, excluding the constants tables. That is a realistic order of magnitude for a symbol-index-only implementation covering 3–5 languages, plus a Postgres schema addition and an eval harness. It is **not** the 78k lines the full product costs, because 90% of that cost is the call graph.

---

## 11. Miscellany

**Language/runtime.** Python `>=3.12` (`$CGR/pyproject.toml:6`), classifiers through 3.14 (`:19`), `.python-version` pinned. Modern idioms throughout: PEP 695 `type` aliases (`$CGR/codebase_rag/graph_updater.py:122-123`), `StrEnum`, `__slots__` on nearly every class, `Protocol`-based structural typing for the ingestor/query boundary (`$CGR/codebase_rag/services/__init__.py`), `NamedTuple`/frozen dataclasses for value types.

**Dependency weight.** 19 required runtime deps (`$CGR/pyproject.toml:37-58`): `loguru`, `mcp`, `pydantic-ai`, `pydantic-settings`, `pymgclient`, `python-dotenv`, `tiktoken`, `toml`, `tree-sitter`+`tree-sitter-python`, `watchdog`, `typer`, `rich`, `prompt-toolkit`, `diff-match-patch`, `click`, `protobuf`, `defusedxml`, `huggingface-hub[hf-xet]`, `pathspec`. Extras: `treesitter-full` (13 grammar wheels, `:100-114`), `semantic` (`qdrant-client` + `torch` + `transformers`, `:116-120`), `milvus`, `ast-grep`, `test`. `uv.lock` resolves **246 distinct packages** across all groups. **Heavy ones (count: ~20)**: `torch` plus ~14 `nvidia-*` CUDA runtime packages, `transformers`, `pandas`, `numpy`, `pymilvus`, `qdrant-client`, `libclang`, `protobuf`, `tiktoken`, `huggingface-hub`, `mcp`, `pydantic-ai`, plus 13 grammar wheels. The base install (no extras) is genuinely light; `[semantic]` is multi-gigabyte.

**License.** MIT, `Copyright (c) 2025 Vitali Avagyan` (`$CGR/LICENSE:1-3`), declared `license = "MIT"` in metadata (`$CGR/pyproject.toml:7`) and in `funding.json:26`. **No CLA, no DCO, no sign-off requirement** — `grep` over `$CGR/CONTRIBUTING.md` (852 lines) finds none. Governance is explicit that "Contributors are credited in release notes and **retain copyright in their contributions**, which are accepted under the project's MIT licence" (`$CGR/GOVERNANCE.md:23`). No dual-licensing signal in the tree; the commercial offering is services, not a proprietary edition. **Caveat**: the copyrighted PDF and third-party source dumps in `$CGR/optimize/` are not MIT-licensable by this project and contradict the blanket MIT declaration.

**Test quality.** 688 test files, **6,325 test functions**, 254,073 LOC — a **3.3 : 1 test-to-production ratio** against 77,691 production LOC. Tests are colocated at `$CGR/codebase_rag/tests/` (`pyproject.toml:172`) with a nested `integration/` dir. Granularity is genuinely fine: `test_same_line_duplicate_qns.py`, `test_cpp_nested_type_containment.py`, `test_csharp_partial_classes.py`, `test_protocol_operator_dispatch.py`, `test_relative_import_package_init.py` — one file per bug class, and the eval harness explicitly names the test that pins each eval invariant (`$CGR/evals/README.md:54-55`, `:90`, `:174-180`). `asyncio_mode = auto`, `--dist=loadgroup` with a documented reason for why it must be an ini-level option (`pyproject.toml:163-171`), markers for `slow`/`integration`/`e2e` (`:177-181`), testcontainers for real Memgraph integration tests. Claimed statement coverage >90% tracked on SonarCloud (`$CGR/docs/architecture/security.md:37`). This is the most credible quality signal in the repo.

**CI — 13 workflows** (`$CGR/.github/workflows/`): `ci.yml` (ruff check + format, `ty` typecheck, unit-test matrix across OS × py3.12/3.13, all actions SHA-pinned, PR-only cancel-in-progress with a written rationale at `:12-18`), `sonarcloud.yml`, `osv-scanner.yml`, `scorecard.yml`, `docker-publish.yml`, `build-binaries.yml`, `publish.yml`, `version-bump.yml`, `docs.yml`, `label-sync.yml`, `split-score.yml`, `poor-quality-management.yml`, `claude-code-review.yml`. Pre-commit runs ruff, `ty`, README regeneration, `bandit --severity-level high`, and the full unit suite (`$CGR/Makefile:83-97`); dev group also carries `semgrep`, `pylint`, `radon`, `vulture` (`pyproject.toml:184-199`).

**Release/packaging.**
- **PyPI**: `code-graph-rag`, console scripts `cgr` and `code-graph-rag` → `codebase_rag.cli:app` (`$CGR/pyproject.toml:60-62`). Three top-level packages shipped: `codebase_rag*`, `codec*`, `cgr*` (`:75`). Package data includes the compose file, the Roslyn `.cs`/`.csproj` tool, and the ast-grep YAML rule packs (`:78-85`). Publishing via GitHub Actions trusted publishing, no maintainer-held token (`$CGR/GOVERNANCE.md:37`). A `smoke_wheel.py` post-build check (`$CGR/scripts/smoke_wheel.py`).
- **Binary**: PyInstaller, driven by `$CGR/build_binary.py` which reads the grammar list back out of `pyproject.toml` so the bundle can't drift from the extras (`:17-33`), plus a checked-in `$CGR/code-graph-rag-darwin-arm64.spec`. Releases are Sigstore-signed keyless and carry SLSA provenance from v0.0.484 (`$CGR/docs/architecture/security.md:39`).
- **Docker**: multi-stage, `uv` layer + pinned base image digests, non-root `appuser`, `ripgrep` in the runtime layer, `pymgclient` built from source (`--no-binary-package`), entrypoint shims `LD_PRELOAD` for arch-specific libz/libzstd (`$CGR/Dockerfile:1-51`). Default `CMD` is `mcp-server`.
- **MCP registry**: `$CGR/server.json` targeting the 2025-12-11 server schema, `uvx`-runnable stdio transport with declared env vars.
- **Docs site**: mkdocs-material, 126-line `mkdocs.yml`, published to docs.code-graph-rag.com by `docs.yml`.

---

## Bottom line for specd

Three things to take, one thing to take carefully, and one thing to leave.

**Take now, no code-awareness required:** (a) the **three-verdict + coverage-gaps** discipline from `$CGR/codebase_rag/flow_verdict.py:1-6,50-94` applied to per-claim citation validation — this is the single highest-value idea in the repo and it costs almost nothing; (b) the **extractor fingerprint** as a second cache key (`$CGR/codebase_rag/parser_fingerprint.py:1-6`), which closes a real hole in specd's per-doc hash skip; (c) **one schema table generating prompt + audit + docs** (`$CGR/codebase_rag/schema_builder.py:35-41` + `graph_audit.py:21-47`).

**Take carefully, for code-awareness:** the **tiered language architecture** and the **qualified-name identity model**. Scope tier 1 to a *symbol index*, not a call graph. The evidence in this repo says the symbol/containment layer is cheap and scores 1.0 against independent oracles across seven languages, while the call graph is where 14,000 lines and the entire 15-pass ordering nightmare live — and spec grounding needs the former, not the latter. Drive it off `git diff` rather than a hash cache; you get rename detection free, which cgr explicitly abandoned.

**Leave:** Memgraph and everything shaped by it. cgr's own scale evidence — two separate retreats to client-side BFS because the graph engine timed out at 101k edges (`$CGR/codebase_rag/dead_code.py:1-7`, `$CGR/codebase_rag/flow_verdict.py:4-6`) — plus the absence of transactions (`$CGR/codebase_rag/services/graph_service.py:225`) is a strong argument that the Postgres-only constraint is not a limitation you're working around. It's the better design.