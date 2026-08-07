# 0005 — Extend runner dispatch to `onboard` jobs; `build` remains deferred

- **Status:** accepted
- **Date:** 2026-08-07
- **Project:** specd

## Context

[[0004-runner-job-dispatch]] scoped dispatch to `spec` jobs only, and named
`onboard`/`build` together as the deferred follow-up, reasoning that both
"need a git checkout (clone, branch, push) on the runner's own machine."

Investigating `OnboardingAgent` to build that follow-up found that premise
was wrong for `onboard` specifically. Its `adapter.snapshot()`/
`adapter.propose()` calls (`GitHubAdapter`, `GitLabAdapter`) are VCS REST API
requests — `GET .../git/trees`, `POST .../git/blobs`, `POST .../git/refs`,
`POST .../pulls` — built with a platform-held, per-request token, not a real
`git clone`/`push`. `WorkspaceService` (real `simple-git` checkouts,
multi-commit branches, running the repo's verify command) is used only by
the *build* station. Onboarding never touches a filesystem for github/gitlab
repos, and for the `local` provider it already runs directly against the
API host's own disk — dispatch changes neither case.

So the only part of onboarding that benefits from running on a runner is the
same thing spec drafting needed: driving the user's own local `claude`.
Everything DB/VCS-dependent can stay server-side exactly as it does for
`spec`, with no new credential-distribution problem to solve.

## Decision

Gave `OnboardingAgent` the same `prepare()`/`finalize()` split `SpecAgent`
got in 0004: `prepare()` does the read-only clone, stack detection, and
prompt assembly (unchanged from the original `run()`, still fully
server-side); `finalize()` takes a drafted-docs result (or `null`), renders
the scaffold, calls `adapter.propose()`, and writes the `repositories` row —
also unchanged, also fully server-side. `run()` is now a three-line
`prepare()` → `models.call()` → `finalize()` sequence, same behavior as
before the split.

`PipelineService.runOnboarding()` gained the same `pickPaired()` branch
`generateSpec()` has: per repository, if a runner is paired, call
`prepare()`, store the result as an `OnboardJobPayload` (`{system, user,
schema, model, maxTokens, ctx}, ctx` carrying the repo/stack/dirs `finalize`
needs), and queue instead of running in-process. `RunnerJobsService.report()`
now switches on `run.kind` (`'spec' | 'onboard'`) rather than hard-refusing
anything but `spec` — the claim/report protocol itself needed no schema
change, exactly as 0004 predicted. The `apps/runner` daemon's dispatchable-
kinds check became a small set (`spec`, `onboard`) instead of a single
equality check; the model-calling code was already generic.

`build` is **not** included here — it is the one job kind that genuinely
needs `WorkspaceService`'s real git checkout, and therefore genuinely needs
to decide how a repo's VCS credential reaches a runner's machine, which 0004
already flagged as the harder, still-open half of this work.

## Consequences

- Dispatch now covers both AI-only stations (spec, onboard); only the
  git-heavy build station remains synchronous-only.
- No new trust boundary was introduced — a runner still never sees a
  database credential or a VCS token, for either job kind.
- The remaining `build` dispatch work is now unambiguously scoped: it is
  entirely about (a) giving `BuildAgent` a runner-side execution path with
  its own git/verify-command handling, and (b) a credential-distribution
  design for short-lived, repo-scoped VCS tokens — not further protocol
  work on the claim/report mechanism, which is already generic enough.
