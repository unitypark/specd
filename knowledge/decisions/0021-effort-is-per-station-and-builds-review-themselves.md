# 0021 — Effort is a per-station setting, and a build reviews itself before it asks you to

- **Status:** accepted
- **Date:** 2026-08-18
- **Project:** specd

## Context

Two gaps, found by reading the agent layer rather than by a failure.

**Effort was typed and then thrown away.** `ModelCallOptions.effort` accepted
all five levels the API takes and defaulted to `high`; three call sites passed
the literal `'high'`; nothing configured it. Worse, the *Claude Code* path
passed no effort at all — so in subscription mode, the setting specd thought it
had chosen did not reach the model. `claude --effort` exists and takes the same
five levels; specd simply never sent it.

One value for every station is wrong in both directions at once. Anthropic's
guidance is that `xhigh` is the setting for coding and agentic work — it is
what Claude Code itself runs at — while cheap mechanical passes are where `low`
belongs. specd ran a build that writes code a human is about to merge at the
same level as an index run that summarises text.

**Nothing read the diff.** The build station runs the repository's verify
command, which answers "do the tests pass" — a question the test suite already
answers. Nothing answered "is this the change we approved, and is it any good".
That reading was left entirely to the human opening the PR, cold.

## Decision

**Effort is per station, with a project override.** `STATION_EFFORT` in
`@specd/shared` sets `build`/`review` to `xhigh`, `spec`/`ground` to `high`,
and `index` to `low`. `effortFor(station, override)` resolves it. A project may
set `projects.effort` to move every station at once; NULL — the default — means
"no preference", not `low`. The value now travels to *both* model paths,
including `claude --effort`, and into the runner job payload so a dispatched
build is not quietly cheaper than a local one.

**A review pass runs between verify and publish.** `ReviewAgent` reads the diff
with read-only tools and answers in a schema: a verdict, a one-line summary,
and findings carrying `path:line`, a severity, and the acceptance criterion or
design claim each bears on. The findings render into the pull-request body,
above the acceptance criteria — the new reading sits above what it is measured
against.

Four properties this is built around:

1. **Advisory, and it says so in the text.** A finding does not fail a build.
   This is the line citation drift already sits on: an unrelated opinion must
   not be able to stop an approved spec from shipping. Making findings
   refusable is a house-rule decision (2.4), not a default.
2. **Read-only by denial, not by omission.** `Write` and `Edit` are in
   `--disallowed-tools` and the pass runs under `--permission-mode plan`, so an
   over-helpful reviewer cannot quietly amend the branch it was asked to
   assess.
3. **An empty findings list is a real answer**, and a clean pass is reported
   rather than omitted — silence would be indistinguishable from a pass that
   never ran, which is the same failure as reporting a green verify for tests
   that did not execute.
4. **It runs where the workspace is.** The prompt is authored on the API side
   (`prepare()` stays side-effect-free, so both paths ask the same thing) but a
   dispatched build reviews on the runner, because the diff is on the runner's
   disk and gone by the time the report arrives.

## Consequences

- Builds cost more per run and should be better for it; indexing costs less.
  Both were previously wrong in the same direction because they shared a dial.
- A pull request now carries a reading of its own diff. The risk is that a
  padded findings list trains reviewers to skip the section, which is why the
  prompt says an empty list is a real answer and the rendering states plainly
  that nothing was acted on.
- The review adds a model call to every build. It is skipped when the diff is
  empty, and every failure in it is soft — the commits exist and verify has
  already spoken, so a review that cannot run costs an opinion, not the build.
- `effort` is one dial for the whole project rather than per station. Someone
  who wants grounding cheap and builds expensive cannot express that yet;
  `effortFor` is the seam where that would go.
