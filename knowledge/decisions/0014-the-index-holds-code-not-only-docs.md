# 0014 — The index holds code, not only docs

- **Status:** accepted
- **Date:** 2026-08-10
- **Project:** specd

## Context

Engineering docs point at code constantly. This repository's own knowledge
tree names 177 source paths across 102 distinct files — in ADR context
sections, in architecture layout tables, in runbooks.

Every one of them was invisible. The `pathref` extractor required a `.md`
suffix, so `apps/api/src/main.ts` in an ADR produced no edge of any kind. A
doc could describe a file deleted two renames ago and nothing would ever say
so, while the same doc's link to a *doc* that moved was caught immediately.

That gap also blocked the honest version of a signal specd already advertises.
[[0013-doc-code-coupling-from-git-history]] can say a doc's coupled area has
moved; it cannot say the specific file a doc names is gone.

## Decision

Index the repository's file tree as `code_nodes`, and resolve doc→code
references against it as a `coderef` edge kind.

- **`kind` is `file` today.** Symbols — function, class, method, with a span
  and a dotted qualified name — land in the same table, which is why those
  columns exist now rather than being migrated in later. A symbol index is the
  next increment, not this one.
- **One listing serves both halves of the index.** For a hosted repo the file
  list is a recursive tree call; asking separately for docs and for code would
  double the cost of every run.
- **A reference that was never ours is out of scope, not broken.** A coderef
  whose first path segment is not a directory of this repository — a Go module
  path, an npm specifier — is dropped rather than stored as unresolved. This is
  the same rule S-102's v2 deviation established for non-`knowledge/` paths,
  applied to the same failure: a health signal that cries wolf gets ignored.
- **Research records are exempt.** A `knowledge/research/` doc describes how
  *another* system works, so its paths point into that repository's tree. `research`
  is now a doc kind, and code references inside one are not resolved. Without
  this, the code-graph-rag analysis reports that repository's file layout as
  our broken references — which is exactly what it did on the first run.
- **Broken code references are their own count.** A dead link between two docs
  and a doc describing code that was deleted are different repairs, so they are
  different numbers rather than one bucket.
- **A link's target is a doc or a code node**, decided by its kind, in two
  nullable columns rather than one polymorphic id — so both keep real foreign
  keys, and a deleted target still nulls itself out. The re-resolution demotion
  now checks both: a resolved row with neither target is what "the thing this
  pointed at is gone" means, and that single rule covers a deleted doc and a
  deleted source file alike.

## Consequences

- Measured against this repository on the day it shipped: **36 code references
  resolve, 1 breaks, 140 are correctly out of scope.** The one break is real —
  a path that no longer exists — and it was invisible before.
- A doc naming a file that was deleted is now a health note rather than a
  discovery someone makes months later while reading a stale runbook.
- The file inventory is replaced wholesale per index run, inside the same
  transaction as everything else, because it is derived from one listing of one
  commit. A stale row would let a deleted file keep answering for references
  to it.
- The GitHub tree API truncates on very large repositories. Nothing detects
  that yet; a truncated listing would report live files as missing, which is
  the one way this signal could cry wolf at scale.
- Symbols were the obvious next layer and landed the same day; see the update
  below.


## Update — 2026-08-10: symbols

`kind` is no longer only `file`. Declarations are indexed in the same table and
a `symbolref` — `` `RunnerJobsService.claim()` `` — resolves against them.

**Extraction is declarative and line-based, not a parser.** That is the tier
the benchmarked engine uses for languages it has no grammar for, and it buys
top-level declarations in TypeScript, Go and Python for a few patterns and no
new dependency. The alternative was promoting a 20 MB compiler from
devDependency to runtime dependency to find `export class`, which is not a
trade [[0008-remove-unused-queue]] would recognise. A real parser per language
is the upgrade path, and the record it produces is shaped so that swapping one
in changes the producer and nothing downstream.

**A member whose container we indexed, and which is not there, is a finding.**
This is the rule that makes the kind worth having. `Parent.member` where
`Parent` is a declaration we know and `member` is not: it was ours, and it is
gone. Where the container is unknown too, the reference was never ours to check
and is dropped rather than reported — the same out-of-scope rule paths get.

Measured on this repository, both of the references that fail to resolve are
real:

- `Config.redisUrl` — removed with the queue in [[0008-remove-unused-queue]].
- `PipelineService.reindex` — renamed to `enqueueReindex` by
  [[0012-index-runs-queued-and-woken-by-listen-notify]].

Two ADRs describing changes this repository made, still referenced by name in
docs that were never updated. Neither was findable before today.

**Scope is the whole tree, referenced files first.** Parsing only the files
docs already name resolved 2 of 18 references, because most symbols live in
files a doc discusses without spelling out a path; parsing everything resolves
16. The order matters more than the cap: when the 200-file cap bites it drops
the files least likely to be cited, and says in the run log how many it
skipped.

Two costs, both real. A hosted repository pays one HTTP GET per parsed file
per index run, which is bounded but not cheap — parsing only what changed since
the last run is the fix, and needs the per-file content identity the
`blob_sha` column is reserved for. And an ambiguous qualified name, the same
`Parent.member` declared in two parsed files, resolves to neither: 56 of 1,027
symbols here. Guessing which one an author meant is how a citation stops being
checkable.


## Update — 2026-08-10: content identity

Every provider already knew each file's blob sha — `git ls-files -s` prints it,
and both hosted tree APIs return it — and all three were throwing it away.
Keeping it does three things.

**It makes symbol extraction incremental.** A file whose blob is unchanged has
the declarations it had last run, so re-reading it is one HTTP GET spent to
learn nothing. Steady state on a hosted repository is now the files that
actually changed, not every file the docs might reference.

**It separates stale from broken.** A link records the blob sha of its target
when the source doc was last indexed, and a doc's links are rewritten only when
that doc changes — so the sha stays frozen at the moment someone last looked.
When the file moves on and the doc does not, the two disagree, and that is
precisely "the code changed and nobody re-read the doc". Distinct from broken,
where the target is gone, because it is a distinct repair: one needs a new
path, the other needs a human to check whether the prose is still true.

**It fixed a bug this ADR shipped with.** Replacing the file inventory
wholesale each run gave every file node a new id, and a link points at that id.
`ON DELETE SET NULL` then nulled every reference from a doc that had not
changed — and because it had not changed, nothing would ever rewrite it. A
resolved reference silently became broken on the next index run. File nodes are
upserted now, so ids are stable, and the regression test does the only thing
that catches this: re-indexes without changing anything and asserts the
reference survives.


## Update — 2026-08-11: retrieval serves the code

The gap this decision left open is closed: retrieval now hands the SpecAgent
the code the seed docs reference, not only the fact of the reference.

A third expansion stage follows the doc-graph hop. Resolved `coderef` and
`symbolref` edges from the RRF seeds are ranked by the same rules doc
expansion uses — edge-kind weight, seed rank as the tie-break — capped at two
snippets, each a bounded window read from the repository **at retrieval
time**. Nothing is stored: git stays the source of truth, and the cost is at
most two file reads per retrieval, which on a hosted repository is that many
HTTP GETs.

The snippet enters the retrieved set as an ordinary chunk with
`via: 'code'`, `path` = the source file and `heading` = the qualified symbol
name — so its CITE-AS is `path#Class.method`, the citation validator's
exact-match branch accepts it like any doc excerpt, and the prompt fences it
so the model reads code as code. Provenance carries the edge id that pulled
it in, and when the doc's frozen sha disagrees with the file's, the label
says the code has moved since the doc last touched it — the snippet itself
is current HEAD, deliberately: the model grounds against what exists while
the stale verdict tells the reviewer the doc has not caught up.

Measured against this repository's own knowledge tree: "how does a runner
claim a queued job" now serves `RunnerJobsService.report` from ADR 0004's own
citation, and "how are citations validated" serves `SpecAgent.prepare` and
`RunnerJobsService.claim` from S-102's design section. The doc-retrieval eval
is unchanged (recall 100%, MRR 0.861) — expansion appends and never
displaces.

Known refinement, deliberately not taken yet: candidates are ranked by edge
weight and seed rank alone, not by query relevance — the same gap doc
expansion had before the retrieval-quality pass fixed it there. Doing the
same here should wait for a labelled case where it matters, rather than
arriving as an unmeasured tweak.
