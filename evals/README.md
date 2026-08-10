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

### Retrieval against a labelled set

`retrieval.eval.ts`. Fifteen questions whose answer is a specific doc in this
repository's knowledge base, scored on recall, recall@3 and MRR. It indexes
into a scratch project, asks, and cleans up, so it needs a database and says
so rather than reporting a zero when there is none.

Fifteen is small, and the number should be read as a regression guard and a
direction rather than a score worth quoting. Saying that matters here because
the failure this is modelled on is the opposite: the benchmarked engine
reports a 12-point lift on **six** graded questions, which is not a
measurement.

| | baseline | now |
| --- | --- | --- |
| recall | 93.3% | 93.3% |
| recall@3 | 80.0% | 80.0% |
| MRR | 0.750 | ~0.795 |

The MRR figure moves by a few thousandths between runs: the scratch project is
recreated each time, so ties break on different row ids. A change smaller than
about 0.01 is noise, not a result.

The one persistent miss is honest about the corpus rather than the engine:
"how do I run the platform locally for the first time" returns
`knowledge/README.md` where the label says `runbooks/local-dev.md`. That
runbook is still a generated stub, and the README genuinely answers the
question better. A fair benchmark occasionally tells you the corpus is wrong.

### Go vs `go/ast`, Python vs `ast`

`native-oracles.eval.ts`, with the oracles themselves in `oracles/` — a Go
program using `go/parser`, and a Python script using the `ast` module. Each is
a subprocess reading paths on stdin and writing JSON, which is the cheapest
interface there is and keeps the oracle honest: it cannot accidentally import
the thing it grades.

Graded against each language's own standard library, which is the number worth
quoting because it is a large corpus nobody tuned the extractor against:

| corpus | files | declarations | precision | recall | F1 |
| --- | --- | --- | --- | --- | --- |
| Go stdlib | 7,654 | 316,078 | 99.2% | 99.7% | **99.5%** |
| Python stdlib | 3,830 | 93,999 | 99.2% | 99.7% | **99.4%** |

Reproduce them:

```
pnpm eval --target "$(go env GOROOT)/src"
pnpm eval --target "$(python3 -c 'import sysconfig;print(sysconfig.get_paths()["stdlib"])')"
```

This repository's own Go is six files, and the extractor scores 100% on it —
which is exactly the number *not* to quote. Six files of one house style, and
the fix below was written against them; the stdlib figures are the honest ones.

The Go oracle earned its place on its first run by finding a whole idiom the
extractor could not see. Go declares related constants as
`const (\n  a = 1\n  b = 2\n)`, and every member is a top-level declaration
with no keyword of its own — so a per-line keyword rule matched none of them.
Seventeen missing in this repository's CLI alone, and recall on Go went 87.6%
→ 100% once grouped declarations were handled.

## What is not graded, and why that is stated rather than hidden

- **This repository contains no Python.** The Python grader reports "no .py
  files in this corpus" rather than a score, because precision and recall over
  zero files are 100% and mean nothing. The stdlib figures above are how that
  oracle is actually exercised.
- **A missing toolchain is a skip, not a pass.** No `go` or no `python3` on
  PATH reports the language as skipped and says which. An eval that cannot run
  must never look like one that ran and succeeded.
- **The default corpus is still this repository.** The benchmarked engine's own
  eval suite defaults to its own source and reports a perfect 1.0 there
  (`knowledge/research/code-graph-rag-engine-analysis.md#7`), which is the one
  place its methodology is weak. Every oracle here is independent of the thing
  it grades, and `--target` now works on any directory rather than only a
  checkout — which is how the stdlib numbers above were produced.

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
