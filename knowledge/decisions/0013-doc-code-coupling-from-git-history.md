# 0013 — Doc↔code coupling is mined from git history

- **Status:** accepted
- **Date:** 2026-08-10
- **Project:** specd

## Context

Git is the one source specd treats as absolute — [[0001-adopt-spec-driven]]
and the D4 rule that the index is derived and git is truth — and until now the
engine only ever read HEAD. Everything it knows about a doc, it learned from
that doc's current text.

That leaves the product's loudest claim thinly supported. `knowledge/README.md`
says specd "flags docs that have drifted from the code". Before 0012's
follow-up work that was a 90-day timer, which measures the calendar. It is now
a count of commits touching *any* code since the doc last changed, which is
better and still blunt: a doc about the runner is not drifted because someone
renamed a CSS variable.

History answers the question the file tree cannot. Files that change together
are coupled, whatever the import graph says — the standard co-change result
from mining software repositories, and the reason it is worth reading history
rather than only parsing HEAD.

## Decision

Mine a bounded window of history for **doc↔code coupling**: which code paths
have historically changed in the same commits as each knowledge doc. Store it,
and use it for drift.

Four rules keep the signal honest:

1. **Bounded window.** Twelve months, not "all". A fifteen-year repository's
   early commits describe an architecture that no longer exists, and coupling
   to a deleted module is noise that outvotes the truth.
2. **Bulk commits are excluded.** A commit touching more than fifty files is a
   formatting sweep, a dependency bump or a mass rename. It couples everything
   to everything, and precision never recovers.
3. **Generated paths are excluded.** Lockfiles, build output and vendored
   directories co-change with everything for reasons nobody wants surfaced.
4. **No author data is stored.** Coupling needs paths and dates. Committer
   names in a generated knowledge base is a privacy footgun with no upside
   here.

**Coupling gets its own table rather than a row in `knowledge_doc_links`.**
The plan this came from proposed reusing the links table with a `cochange`
kind and the `origin_tier` seam. That was wrong on inspection. Every other row
in that table points at a *doc*, and three consumers rely on it: broken-link
health counts, one-hop expansion, and the doc-links UI. A coupling row points
at a code path, has no `resolved_doc_id`, can never be expanded across
(there are no chunks behind a source file yet), and would force a tier filter
into all three. The `origin_tier` seam stays reserved for what it was built
for — a second producer of *doc→doc* edges.

**It runs where a real repository is.** Mining needs `git log`, and the
GitHub and GitLab adapters are REST clients with no clone: crawling history
through a paginated API would be rate-limit suicide. So this ships for the
`local` provider, where the adapter already holds a working tree, and hosted
repositories keep the coarser repo-wide drift count until the follow-up below.
That boundary is stated in the UI rather than hidden — a doc whose coupling
was never computed says so, the same way freshness says "unmeasured" rather
than "fine".

**It runs after the index transaction, never inside it.** Coupling is a
derived hint. A `git log` walk must not hold write locks, and must not fail a
run whose indexing already succeeded.

## Consequences

- Drift becomes specific enough to act on. "6 commits touched
  `apps/api/src/runners/` since this doc last changed" names the doc to read
  and the code to compare it against; "25 commits touched code" does not.
- A doc's coupling is itself a review artefact: a runbook coupled to a module
  nobody has touched in a year is probably describing something that no longer
  matters, and one coupled to five unrelated areas is probably three docs.
- Coupling is recomputed per index run for local repos, over a bounded window,
  so cost is proportional to the window rather than to repository age.
- ~~**Hosted repositories get nothing from this yet.**~~ Closed the same day by
  taking the webhook route (see the update below).
- This is the first thing specd derives from history rather than from HEAD. If
  it earns its place, the same walk yields hotspots and change cadence for the
  onboarding draft — the generated architecture doc could describe the parts of
  the system that actually move.


## Update — 2026-08-10: hosted repositories

The webhook route was taken, and no clone was needed after all.

A push delivery already carries what history mining wants: sha, timestamp, and
the files each commit touched. Those land in `repo_commits`, keyed on
`(repository_id, sha)` so a redelivery cannot double-count, and pruned to the
same twelve-month window. Both providers now read through one history source —
`git log` where there is a working tree, the ledger where there is not — and
everything downstream is unchanged, because `couplingFrom` never knew where its
commits came from.

Three consequences worth stating plainly:

- **Only default-branch pushes are recorded.** Coupling has to describe what
  landed. This also means `classifyPush` and the ledger answer different
  questions: a push touching only application code triggers no re-index and is
  exactly what drift is made of, so it is recorded even though nothing else
  happens because of it.
- **The ledger is a lower bound, and is treated as one.** It knows nothing from
  before specd was installed, and GitHub truncates `commits` on very large
  pushes. Both lose history rather than corrupting it: an uncoupled doc reads
  as unmeasured, which is what it is, and the existing "freshness unknown"
  path already says so rather than claiming freshness.
- **A hosted doc gets a real change date.** The ledger knows when each doc's
  path was last touched, which is the first time `doc_updated_at` has been
  anything but null outside local mode. That was the false negative behind
  every hosted doc reporting as permanently fresh.

The per-doc `commitsSince` git call this originally used is gone: the same
number now falls out of the single history walk that coupling already does, for
every provider, instead of one subprocess per doc.
