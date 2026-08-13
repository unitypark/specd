# Semantica analysis — external research

> status: point-in-time snapshot · analyzed 2026-08-13. Like `specs/`, this is
> a historical record of what was true when it was written — do not update it
> as semantica evolves; append corrections instead.

**What was analyzed:** [semantica-agi/semantica](https://github.com/semantica-agi/semantica)
at v0.6.5, commit `611874e` (2026-08-13), via a shallow read-only clone plus the
public docs site (docs.getsemantica.ai) and repository web pages. Python 3,
349 engine files / ~179k LOC under `semantica/`, 267 files under `tests/`,
~6.5k stars · 681 forks · MIT. Plugin manifests still point at
`Hawksight-AI/semantica` (`plugins/.claude-plugin/plugin.json`), the org it
shipped from before the current one.

**Why it exists:** engine research round № 3. Round № 1 (graphify) fed S-102's
retrieval and guard design; round № 2 (code-graph-rag) produced
`docs/improvements-plan.html`, delivered across PRs #35–#60. This round was
commissioned to benchmark the two places specd has not yet been benchmarked:
the **agent-facing integration surface** and the **knowledge lifecycle after
indexing** (precedent, change, policy). The fit assessment (§9) feeds
`docs/improvements-plan-semantica.html`.

**Citation caveat:** every `file:line` reference below points into the
*semantica* source tree at the version above — never into this repository.
Claims sourced from the docs site rather than the clone say so.

---

## 1. What semantica IS

Semantica is a **self-hosted, graph-native context and decision layer for AI
agents**, positioned as "the open source Palantir for AI agents" and aimed at
regulated domains (finance, healthcare, legal, government) where agent
decisions must be explainable and auditable. The shape is a Python library
first — `pip install semantica` — with a CLI, REST server, browser "Knowledge
Explorer" (React 19 + Sigma.js), MCP server, and editor plugins layered on top
of the same modules.

The pipeline it sells: Sources → Ingest → Parse → Normalize → Split → Extract →
Conflict Detection → Deduplication → Knowledge Graph → [Ontology / Reasoning /
Provenance / Decisions] → Enriched KG → Export / Visualize / REST / MCP / CLI.
Extraction is LLM-driven (NER, relations, events, triplets) with ~11 LLM
providers supported via `semantica.llms` and LiteLLM; storage is polyglot (RDF
triple stores and property-graph DBs: Neo4j, FalkorDB, Apache AGE, Neptune,
Oxigraph…); vector search spans FAISS/Qdrant/Weaviate/Milvus/Pinecone/PgVector.

Maturity signals: single 4,400-line `click` CLI (`semantica/cli.py:28`,
command groups registered through `:4363-4365`); issue numbers in commit
subjects reach **#928**; the analyzed commit is itself a security fix ("apply
SSRF guard to feed ingestion requests", #928) in a line of hardening releases
(v0.6.5 addressed auth, SSRF, injection, ReDoS). This is an actively iterated,
community-driven codebase, not a demo.

## 2. What it is NOT — the category boundary

Semantica is **not a spec-driven delivery product** and does not compete on
specd's axis:

- **No specs, no gate.** Nothing in it produces requirements, designs or
  tasks; nothing enforces a human approval before agent work. Its
  `PolicyEngine` (§4) is advisory code an agent calls, not a structural gate.
- **No repo grounding.** It does not read a codebase, measure doc↔code drift,
  or cite source as evidence. Its knowledge comes from *ingested documents*,
  its truth model is *extracted facts*, and freshness is *temporal validity
  windows* — not verification against a repository.
- **Different memory substrate.** The `ContextGraph` is an in-memory Python
  structure with explicit `save()`/`load()` (`semantica/context/context_graph.py`,
  docs: agent-memory guide) — there is no git, no Postgres, no derived-index
  discipline underneath it.

The overlap zone — and the reason it benchmarks specd at all — is
**knowledge-for-agents**: both products maintain a queryable knowledge layer
agents are supposed to consult before acting, and both must solve integration,
freshness, precedent and audit. Semantica's answers to *integration* and
*lifecycle* are state of the art; its answers to *truth* are weaker than
specd's (extracted facts + confidence floats vs. cited claims + four verdicts).

## 3. The agent-facing surface (the headline finding)

This is where semantica is furthest ahead of specd, and it is a **pattern now,
not a data point**: graphify (round № 1) shipped an MCP server, PreToolUse
hooks and a skill runbook; semantica ships all three, productized further.
specd ships prose (`AGENTS.md`) and one read-only CLI verb.

### 3a. MCP server — 17 tools, 4 resources, 7 editor configs

`mcp/` is a self-contained modular package: `server.py` (stdio, newline-
delimited JSON-RPC 2.0, logs to stderr only), `schemas.py` (JSON Schema per
tool input), `session.py` (graph singleton), `tools/` split by domain —
`extraction.py`, `decisions.py`, `graph.py`, `reasoning.py`, `export.py`
(`mcp/README.md`). The tool inventory:

| Domain | Tools |
|---|---|
| Extraction | `extract_entities`, `extract_relations`, `extract_all` |
| Decisions | `record_decision`, `query_decisions`, `find_precedents`, `get_causal_chain`, `analyze_decision_impact` |
| Graph | `add_entity`, `add_relationship`, `search_graph`, `get_graph_summary`, `get_graph_analytics` |
| Reasoning | `run_reasoning`, `abductive_reasoning` |
| Export/Provenance | `export_graph`, `get_provenance` |

Plus four **resources** — `semantica://graph/summary`, `://decisions/list`
(most recent 50), `://schema/info`, `://ontology/schema` — so an assistant can
*pull ambient state* without a tool round-trip. The README ships copy-paste
configs for Claude Code, Cursor, Windsurf, Cline, Continue, VS Code/Copilot
and Amazon Q. Setup is `pip install -e ".[mcp]"` then `python -m mcp`.

Design points worth keeping: tools grouped by domain in separate modules;
input schemas centralized; a session singleton so tools share one graph; the
resource URIs as a read-only ambient layer distinct from tools.

### 3b. Editor plugins — the workflow ships as artifacts, not prose

`plugins/` contains **eight** per-editor manifest flavors (`.claude-plugin`,
`.cursor-plugin`, `.codex-plugin`, `.continue-plugin`, `.cline-plugin`,
`.vscode-plugin`, `.windsurf-plugin`, `.openclaw-plugin`) over one shared body
of `skills/`, `agents/` and `hooks/`:

- **`plugins/.claude-plugin/`** is a real Claude Code plugin: `plugin.json`
  (name, description, `"skills": "./skills"`, `"agents": "./agents"`) plus
  `marketplace.json` — the repo itself is an installable plugin marketplace
  (`semantica-local`), so distribution is `git clone` + point Claude at it.
- **17 skills**, one directory each with a frontmattered `SKILL.md` (`name`,
  `description`) — `causal`, `change`, `decision`, `deduplicate`, `embed`,
  `explain`, `export`, `extract`, `ingest`, `ontology`, `policy`,
  `provenance`, `query`, `reason`, `temporal`, `validate`, `visualize`. Each
  skill is a *sub-commanded runbook* (`/semantica:decision record|query|…`)
  whose body is executable Python the assistant runs against the library
  (`plugins/skills/decision/SKILL.md`). The skill IS the API documentation,
  kept next to the code it drives.
- **3 agents** — `kg-assistant.md`, `decision-advisor.md`, `explainability.md`
  (`plugins/agents/`). `kg-assistant.md` is an API-expert persona whose body
  is an exhaustive signature reference for every module — the "knows the exact
  method names" problem solved with a checked-in prompt.
- **Hooks that enforce, not suggest** (`plugins/hooks/hooks.json`): a
  PostToolUse hook AST-parses any `semantica/` file the assistant writes
  (`python -c 'import ast; ast.parse(...)'` on Write|Edit), and a PreToolUse
  hook on Bash warns when a command touches a deprecated internal path. Small,
  but the mechanism is the point: **the working agreements run as code**.

## 4. Decision intelligence — records that answer questions

Docs: guides/decision-intelligence; code: `semantica/context/` (16 files —
`decision_models.py`, `decision_query.py`, `decision_recorder.py`,
`causal_analyzer.py`, `policy_engine.py`, …).

- A `Decision` is a first-class node: `category`, `scenario`, `reasoning`,
  `outcome`, `confidence` (0–1 float), `decision_maker`, `timestamp`, optional
  `valid_from/valid_until`, `entities[]`, metadata. `record_decision()` writes
  the node *and embeds it* for later search.
- **`find_precedents()`** is the killer verb: hybrid scoring — ~70% semantic
  similarity over scenario/reasoning text, ~30% structural graph proximity
  (Node2Vec) — returning ranked past decisions. Their docs are careful:
  "precedents guide rather than determine."
- **Causal chains**: `add_causal_relationship(src, tgt, "CAUSED"|"INFLUENCED")`,
  traversed up/downstream with `max_depth`, annotated with `hop_count`,
  `confidence_decay` and a human-readable interpretation
  (`trace_decision_causality()`).
- **PolicyEngine**: versioned `Policy` nodes with rule sets;
  `check_compliance(decision, policy)` before recording; non-compliant
  decisions recordable as **exceptions carrying approver identity and
  justification** (`record_exception()`).
- `get_decision_insights()`: counts, confidence stats, category/outcome
  breakdowns — the shift-handover / audit view.

**Read against specd:** specd already owns *better* decision records — an
approved spec has a named human approver enforced by a DB constraint, cited
evidence with verdicts, and an as-built record with deviations. What specd
lacks is everything semantica builds *on top of* records: retrieval as
precedent, links as causality, policy as data, insight rollups. The records
are inert.

## 5. Temporal validity & change management

Docs: guides/context-graphs, guides/change-management; code:
`semantica/change_management/` (`change_log.py`, `managers.py`,
`version_storage.py`, `ontology_version_manager.py`).

- Nodes and edges carry `valid_from`/`valid_until`; queries can exclude
  expired facts; `state_at(datetime)` reconstructs a point-in-time view;
  `find_active_nodes(..., at_time=…)` filters by window.
- `TemporalVersionManager`: whole-graph **snapshots** into SQLite with author,
  label, counts and a SHA-256 checksum; `compare_versions()` produces
  structural diffs (nodes/edges added/removed with payloads);
  `verify_checksum()` before publishing downstream; `restore_snapshot()`
  demands an explicit `require_confirmation=False` so automation can't
  rollback by accident; `attach_to_graph()` records per-node mutation history.
  Their own docs flag the limit: frequent snapshots of large graphs bloat —
  "whole-graph checkpoints, not event sourcing."

**Read against specd:** this entire subsystem is **git, rebuilt for people who
don't have git underneath their knowledge**. specd's knowledge is files in the
repo; snapshots, diffs, checksums, authorship and rollback are native. What
transfers is not the machinery but the *product surface* on top of it: the
digest of "what changed in what we know" after each index run, and the
question "has the evidence this spec cited changed since approval?" — both
cheap for specd, both currently unasked.

## 6. Agent memory

Docs: guides/agent-memory. Three layers under one `AgentContext`: FAISS-backed
vectors (semantic), `ContextGraph` (structural), conversation namespaces
(episodic/working). Retrieval blends similarity with graph proximity
(`proximity_weight` per call); `conversation_id` scopes working memory;
lifecycle is `retention_days` + `max_memories` ring buffer + `forget()` /
`clear(days_old=…)`; persistence is explicit `save()`/`load()` — their docs
warn everything is lost otherwise.

**Read against specd:** specd's equivalents are structural, not runtime — the
worktree, the spec's task list, the as-built record. Nothing to adopt here;
the note is that semantica *needs* this subsystem because its agents are
long-running chat processes, while specd's agents are bounded runs against a
repo. Different problem, correctly not shared.

## 7. Adoption & community machinery

The funnel is disciplined and worth copying almost verbatim:

- **Time-to-first-value:** `pip install semantica` → a documented 5-minute
  quickstart (ingest → extract → build graph → query → record a decision) →
  bare `semantica` launches a dashboard. One command, one dependency-free
  happy path.
- **`semantica doctor`** (`semantica/cli.py:779`) — environment/config
  verification with a `--json` flag; **`semantica init`** (`:883`) scaffolds a
  project; **`semantica watch`** (`:951`) re-ingests on file change.
- **Docs IA** (docs.getsemantica.ai): Core Concepts, **"Choose the Right
  Module"**, Glossary, then 22+ task-oriented guides (one per capability, one
  per integration), then API reference. The "choose the right module" page is
  the standout — it triages readers *before* they hit reference depth.
- **Cookbook** of Jupyter notebooks in-repo; **Discord + GitHub Discussions**;
  CHANGELOG.md *and* RELEASE_NOTES.md; SECURITY.md with real security releases
  behind it; CONTRIBUTING.md; issue templates. README leads with performance
  receipts (node search 0.004 ms on a 118k-node graph, "6,000×"; dedup
  blocking 6.98× — reported here as their claims, not verified).

**Read against specd:** specd's README is strong and honest, but the funnel
behind it is heavy — clone, pnpm, Docker Postgres, env vars, web wizard — and
`knowledge/runbooks/deploy.md` self-reports `UNVERIFIED — no host`. specd has
CONTRIBUTING.md and SECURITY.md; it has no changelog, no discussions, no
issue templates, no doctor, and no one-command evaluation path.

## 8. Scale & maturity signals

| Signal | Value |
|---|---|
| Engine | 349 Python files, ~179k LOC (`semantica/`) |
| Tests | 267 files under `tests/` |
| Community | ~6.5k stars, 681 forks, Discord, Discussions |
| Cadence | issue refs to #928; v0.6.x security-release line |
| Surface | 22 CLI command groups; 17 MCP tools; 17 skills; 8 editor flavors |

The breadth is also the warning: 22 command groups, ~10 storage backends,
~11 LLM providers and a full ontology stack is an enormous maintenance
surface for a v0.6 project. specd's counter-position — one store, one
provider, six stations that "cannot be added, skipped or removed" — is a
feature this analysis does not recommend trading away.

## 9. Fit assessment

**Adopt** (specd-shaped versions specified in the improvements plan):

1. **MCP server over the engine** — read-only: retrieval with citations and
   expansion provenance, doc fetch, citation verification, spec pull/status
   (approved-only, mirroring CLI exit-3 semantics), health. Resources for
   ambient state (`specd://knowledge/health`, `specd://specs/awaiting-review`).
   Domain-split tool modules and centralized schemas, per `mcp/` layout.
2. **Claude Code plugin with skills + hooks + marketplace.json in-repo** —
   turn AGENTS.md rules 1–9 from prose into executable workflow: pull-first,
   cite-as-you-design, as-built-on-completion, docs-ride-the-change enforced
   by hooks against `specd spec status` exit codes.
3. **Precedent retrieval over specd's own records** — as-built specs and ADRs
   surfaced as ranked precedents at spec-draft time and in review.
4. **Change digest per index run** — the `compare_versions()` product surface
   on top of git+index, without the snapshot machinery.
5. **`specd doctor`**, a one-command demo profile, changelog + discussions.

**Adapt with care:**

6. **Policy-as-data on the gate** — per-project rules (max UNVERIFIED claims,
   minimum health to build) checked where `assertCanRun` already lives, with
   semantica's best detail kept: exceptions recorded with approver +
   justification, never silent.
7. **Citation re-verification at build time** — semantica's temporal-validity
   instinct ("is this fact still valid *now*?") applied at specd's gate.

**Reject, with reasons:**

- **Confidence floats and LLM extraction at index time** — specd's four-verdict
  citations and deterministic indexing are the moat; floats are vibes.
- **Whole-graph snapshot/checksum/rollback machinery** — git already provides
  it; the index is derived and rebuildable by design.
- **Ontology stack (OWL/SHACL/SKOS), polyglot graph/vector backends** — ADR
  0008 removed Redis for less reason than this; one Postgres is the feature.
- **Authoring CLI breadth** — the CLI's fetch/register/report-only discipline
  is load-bearing for the gate; 22 command groups would dissolve it.
- **Runtime agent-memory tiers** — bounded runs + worktrees + as-builts are
  specd's memory model; correct as is.
