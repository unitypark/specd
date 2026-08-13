# 0016 — Grounding runs are queued rows, and an abandoned one is failed rather than retried

- **Status:** accepted
- **Date:** 2026-08-13
- **Project:** specd

## Context

`POST /projects/:slug/onboard` ran `PipelineService.runOnboarding` inline. For
each repository it opened a run, read the repository, called a model, rendered
the scaffold and opened the setup PR — all before the response. Since
[[0015-onboarding-reads-the-repo-before-it-drafts]] the read is deliberately
deep, so the request got longer, not shorter.

Two things were wrong with that, and only one of them is about latency.

The request stayed open for a repository read plus a 32k-token model call. That
is the same shape [[0012-index-runs-queued-and-woken-by-listen-notify]] took out
of the webhook path, for the same reason.

The other is worse. Nothing made grounding single-flight. `agent_runs` carried
no constraint and no code path looked for a run already in progress, so two
clicks on "Run setup" — or a retried request, or two people in the wizard at
once — produced two runs against one repository: two repository reads, two model
calls, and two attempts to open the same setup PR. The wizard's button disables
itself while busy, which is presentation, not a guarantee.

The mechanism to fix both already existed. 0012 built a queued-row worker for
index runs, over the claim shape [[0004-runner-job-dispatch]] established. This
decision applies it to a second kind rather than inventing anything.

## Decision

An onboarding run is an `agent_runs` row inserted `queued`, one per repository,
naming its repository in the existing `repository_id` column.
`OnboardQueueService` claims and executes it: woken by `LISTEN`/`NOTIFY` on
`specd_onboard_queued`, drained at startup and on a 60s safety tick, claimed
with `UPDATE … FROM (SELECT … FOR UPDATE SKIP LOCKED)`. Every property 0012
argued for carries over unchanged — the row is the truth, the notification only
decides when to look, and two API instances on one channel are safe by
construction rather than by luck. This is still not a queue *system*: Postgres
remains the only store, which is what [[0008-remove-unused-queue]] asked for.

Four things are specific to grounding.

**Single-flight, not burst-folding.** `pendingOnboardRun(projectId,
repositoryId)` matches `queued` *or* `running`, and a second request folds into
the run it finds, returning `coalescedInto`. `pendingIndexRun` deliberately
matches only `queued` — a run already executing has passed the point where
another can join it — but that reasoning is about waste. Indexing twice costs
time; grounding twice opens a second pull request. A grounding run stops being
a fold target only when it reaches a terminal status.

**`job_payload` stays null while queued.** `onboard` is a dispatchable kind
([[0005-onboard-job-dispatch]]) and a runner's claim keys on `job_payload IS NOT
NULL` for such a kind. Filling it at enqueue time — the obvious place to put the
repository id — would let a paired runner claim a job whose prompt has not been
assembled yet. The repository travels in its own column instead.

**The claim filters `runner = 'hosted'`.** When the worker finds a paired runner
it calls `prepare()` and hands the row on with `queueForRunner`, which sets
`runner = 'self_hosted'` and returns the row to `queued` for the runner to poll
for. Without that filter the worker would immediately claim back its own
dispatch. This is the mirror of the hazard 0012 closed from the other side, and
it is load-bearing rather than defensive.

**An abandoned run is failed, not restarted.** This is the one place this
decision departs from 0012, and the reason is that grounding has an external
side effect that indexing does not. `OnboardingAgent.finalize()` ends in
`adapter.propose()`. For GitHub that force-resets the fixed `specd/setup` branch
and then `POST`s a pull request with no handling for one that is already open —
unlike `openPullRequest`, which the build station needs to be re-runnable, and
unlike GitLab's `propose`, which routes through `openMergeRequest` and returns
an existing MR. So an executor that died after proposing would, on restart, pay
for a second model call and then fail at the PR anyway.

The rule is uniform across providers rather than conditional on the one whose
adapter is unsafe: a worker deciding whether to replay side effects based on
which VCS a run happens to use is a distinction that would be easy to get wrong
and hard to test. So a run found `running` past its lease is finished as
`failed`, saying in its own log that it may already have opened a setup PR and
that a human should check before starting again. The repository is left free to
be grounded again; the choice sits with a person, which is where this product
puts choices.

That makes the lease's failure mode asymmetric, so it is generous: 30 minutes,
against the index worker's 15. Cutting a slow-but-live run short now costs
someone their grounding, where waiting only costs them time.

`assertCanRun` is checked twice — in the request, so a paused project or a spent
cap is an answer to *that* request, and again in the worker, because either can
change while a run waits. A claim is not a standing permission.

## Consequences

- `POST /projects/:slug/onboard` returns
  `[{ repositoryId, repoName, runId, queued: true, coalescedInto? }]` instead of
  branches, file counts and review hints. Callers follow the run, exactly as
  re-index callers have since 0012.
- The setup wizard needed no new machinery: it already polled `queued` results,
  because the paired-runner path produced them. It needed new *copy* — it said
  "queued for your runner", which is now wrong in the common case where the
  API's own worker executes the run.
- Onboard runs appear in the runs list as `queued` before `running`, and carry
  no model until a worker resolves one. That is new for this kind and is the
  honest state.
- **No schema change.** `repository_id`, `runner`, `status` and `started_at`
  already existed; this decision only reads them differently. A `running`
  onboard row left behind by a deploy of the old inline code is swept by the new
  worker once past its lease and marked failed — correct, since the process that
  owned it is gone.
- Following the run from `e2e-loop.ts` surfaced that its `awaitRun` helper read
  `status` off the `{ run, logs }` envelope rather than off `run`, so every wait
  it performed ran to its timeout reporting `undefined`. It had one call site
  (re-index) and `pnpm loop` is not part of `pnpm test`, which is why it sat
  unnoticed. Fixed here because this change adds the second call site.
- ~~**Not fixed here:** GitHub's `propose()` still cannot be run against a
  repository that already has an open `specd/setup` PR — re-grounding such a
  repo fails at the PR step, queue or no queue.~~ Fixed 2026-08-13; see the
  update below.

## Update — 2026-08-13: the re-grounding hazard is closed

`GitHubAdapter.propose()` now ends by calling `openPullRequest()` — the method
the build station already used — instead of posting a pull request directly.
The branch it force-resets is the right one either way; if a PR is open for
that branch it now shows the new commit and wants returning rather than
repeating. Before, re-grounding died on GitHub's 422 having already written the
scaffold and moved the branch, which is the worst place to stop: the repository
was changed and the person was told it had failed.

This does not disturb the reasoning that made an abandoned run fail rather than
restart. Re-running is now *safe* where it was fatal, but it is still not free —
it pays for a second repository read and a second model call, and it moves a
branch someone may be part-way through reviewing. Whether to spend that stays a
person's decision, which is where this ADR left it.

Both adapters also stopped announcing "Opened" for a pull request they found
rather than created. `existing` was already returned by `openPullRequest` and
`openMergeRequest` and was being discarded at both call sites; the setup wizard
prints that line verbatim, so a re-run now reads `Updated PR #3 …`.

`GitHubAdapter` had no test file at all. It has one now, covering the create
path, the re-run path, branch reset, and the case that must still fail — a 422
with no open PR behind it, which would otherwise report a review surface that
does not exist.

`UNVERIFIED` — GitLab's `propose()` deletes and recreates the setup branch
(`deleteBranchIfExists`) rather than force-updating it, so a re-run there may
close the open MR and open a new one instead of updating it in place. It does
not *fail*, which is why it is not part of this fix, but what GitLab does to an
open MR whose source branch is deleted has not been checked against a live
instance. Worth confirming before re-grounding is offered as a routine action.
