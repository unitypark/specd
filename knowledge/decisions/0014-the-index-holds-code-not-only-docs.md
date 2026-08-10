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
- Symbols are the obvious next layer, and the plan they came from is explicit
  that the symbol layer is worth roughly a tenth of what a call graph costs
  (per knowledge/research/code-graph-rag-engine-analysis.md#10-fit-assessment).
  Spec grounding needs the former.
