# evals/ — grading, not asserting

Two different jobs live in this repository, and mixing them makes both worse.

**Tests assert behaviour.** They are binary, they run in `pnpm test`, and a
failure means something is broken.

**Evals grade quality.** The number moves when the corpus moves. A suite that
fails because somebody wrote an unusual class is a suite people learn to
ignore, so these are a script you run and read — never a gate.

```
pnpm eval                      # this repository
pnpm eval --target ../other    # any checkout you point it at
```

Results land in `results/` and are committed, so a change in the score is
visible in a diff rather than only in someone's terminal.

## What is graded

### Symbol extraction vs the TypeScript compiler

`symbols.eval.ts`. The extractor is declarative and line-based by design
(`knowledge/decisions/0014`), trading exactness for costing no runtime
dependency. That trade is only defensible if somebody measures what it costs.

The oracle is the TypeScript compiler — a devDependency, which is precisely why
it was rejected as the extractor and precisely why it is the right grader here:
independent, exact, and free because it never ships. Both sides see the same
file set, so neither can win by looking at files the other did not.

Current score on this repository: **precision 98.7%, recall 100%**, over 1,066
declarations in 148 files.

The first run of this eval found three bugs in ten minutes: `export default
function` was invisible to the extractor (every Next.js route), an interface's
methods were invisible to the *oracle* — the grader was wrong, not the thing
graded — and an indentation-scoped member rule was attributing a `describe`
block's calls to the interface above it.

The remaining precision gap is example code inside template literals: the
scaffold generator declares sample services as strings, and a line-based reader
cannot tell those from real ones. Tracking template literals was tried and
reverted; it reaches 100% precision and costs a point of recall, which is the
wrong trade here. A symbol we *miss* whose container we did index reads as
"this symbol was deleted", so a false negative manufactures a false finding,
while a false positive only indexes a declaration nobody references.

## What is not graded, and why that is stated rather than hidden

- **Go and Python have no oracle.** They are extracted and ungraded. That is
  the honest state; reporting the TypeScript score as though it covered them
  would be the dishonest one.
- **The default corpus is this repository.** The benchmarked engine's own eval
  suite defaults to its own source and reports a perfect 1.0 there
  (`knowledge/research/code-graph-rag-engine-analysis.md#7`), which is the one
  place its methodology is weak. The oracle here is genuinely independent of
  the thing it grades, so the corpus matters less — but a single codebase is
  still one house style, and `--target` exists so that is one flag away rather
  than a rewrite.

## The eval that is a test

Incremental correctness is graded by a **clean rebuild**, and that one lives in
`apps/api/src/knowledge/knowledge-graph.integration.test.ts` because it is
binary: a sequence of incremental index runs either reproduces a single run
over the same tree or it does not.

It is the check the benchmarked engine credits with catching its real bugs —
only 10 of 25 edits reproduced a clean index before it was written — and it
earned its place here immediately. It found that code links were only
re-evaluated when their *doc* changed, so a reference to a deleted symbol
lingered as broken forever while a fresh index correctly dropped it. Health
counts were a function of edit history rather than of the repository.
