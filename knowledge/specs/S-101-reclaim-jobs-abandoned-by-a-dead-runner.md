<!-- Filed automatically by specd when S-101 was built. -->
<!-- This is a historical record: never rewrite it. If reality later -->
<!-- diverged, append a "## Deviations" section below.              -->
# S-101 — Reclaim jobs abandoned by a dead runner

> spec v1 · status: approved
> approved by Theo on 2026-08-10T02:36:45.758Z

## Requirements

### As a specd user whose runner died mid-job, I want the job to become claimable again automatically so that I can get my spec or build finished without touching Postgres.

- **WHEN** a job has status `running` with a `runner_id` set and its owning runner's last heartbeat is older than the configured lease timeout **THE SYSTEM SHALL** make that job eligible for claiming by any polling runner
- **WHEN** a job is reclaimed after lease expiry **THE SYSTEM SHALL** append a log line to the run recording that the job was reclaimed from an unresponsive runner
- **WHILE** the owning runner is still heartbeating within the lease timeout **THE SYSTEM SHALL** keep the job unclaimable by any other runner
- **IF** a runner reports or posts progress for a job it no longer owns because the job was reclaimed **THE SYSTEM SHALL** reject the request and not mutate the run
- **WHEN** two runners poll for work concurrently and an expired-lease job exists **THE SYSTEM SHALL** grant that job to exactly one of them

### As a specd operator, I want reclaim behaviour to be observable and bounded so that a job is not reclaimed indefinitely in a crash loop.

- **WHEN** a job has been reclaimed more than the configured maximum number of times **THE SYSTEM SHALL** mark the run failed with an error stating the job was repeatedly abandoned
- **WHEN** a run transitions to failed after exhausting reclaim attempts **THE SYSTEM SHALL** leave the associated spec or build in a state the user can retry from the UI
- **WHERE** the job kind is `build` **THE SYSTEM SHALL** apply a lease timeout configured independently from the `spec` job kind

## Design

- The gap being closed is the one this decision recorded explicitly: "no lease timeout (a runner that crashes mid-job leaves it stuck `running` forever)", tracked in `docs/runners.md`. This work is the implementation of that known gap, so `docs/runners.md` must be updated to drop it from the known-gaps list. _(per knowledge/decisions/0004-runner-job-dispatch.md#consequences)_
- Reclaim belongs inside `RunnerJobsService.claim()`, which already uses raw SQL through `DB_HANDLE`'s `postgres.Sql` client: `UPDATE agent_runs SET runner_id = ..., status = 'running' WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING ...`. The change is to widen that inner SELECT's predicate to also match rows that are `running` with an expired lease, keeping `FOR UPDATE SKIP LOCKED` — this preserves the existing guarantee that two concurrently polling runners never claim the same row, without a lock table or application mutex. _(per knowledge/decisions/0004-runner-job-dispatch.md#decision)_
- Liveness is derived from the `runners` table, which already carries `lastSeenAt` (`packages/db/src/schema.ts`) alongside `pairCode`/`pairedAt`/`tokenHash`. A lease predicate of the form "owning runner's `last_seen_at` older than N" therefore needs no new liveness store; a per-job `claimed_at` already exists on `agent_runs` and can bound the lease independently of runner-level heartbeating. _(per knowledge/decisions/0003-runner-pairing-before-dispatch.md#context)_
- The ticket's premise that build changed the risk profile is correct: `spec` and `onboard` each reduce to one model call, whereas a build is N model calls each with editing tools against a real directory, with commits between them — minutes of wall clock during which a laptop can sleep. Lease timeouts should therefore be per job kind, not a single global constant. _(per knowledge/decisions/0009-build-dispatch-runner-git-credentials.md#context)_
- A build already appends log lines to the run as it goes via `POST /runners/jobs/:id/progress`, added precisely because a dispatched build is otherwise a blank screen. Reclaim events should be surfaced through the same run-log/SSE surface rather than a new notification channel, so "your runner went away, another picked it up" is visible where the user is already watching. _(per knowledge/decisions/0009-build-dispatch-runner-git-credentials.md#consequences)_
- Ownership must be enforced on the report path, not just the claim path: `RunnerJobsService.report()` routes on `run.kind` and, for `spec`, calls `finalize()` and creates the spec version. A zombie runner that wakes up after its job was reclaimed must not be able to write a second spec version, so `report`/`progress` should verify the caller's `runner_id` still matches the row and reject otherwise. _(per knowledge/decisions/0004-runner-job-dispatch.md#decision)_
- Reclaiming a `spec` or `onboard` job is safe to re-run from scratch because the whole job is the opaque `{system, user, schema, model, maxTokens}` payload stored on the row — a second runner replays the identical `jobPayload` and the server-side `finalize()` applies the same normalization invariants either way. _(per knowledge/decisions/0004-runner-job-dispatch.md#decision)_
- Reclaiming a `build` is not equivalently idempotent: the runner's filesystem *is* the state carried between calls, and partial work may already have been pushed to the git remote under the dead runner's own credentials. A reclaimed build should therefore start from a fresh checkout on the new runner and must not assume the prior branch state; whether the prior partial branch is reused, force-updated, or abandoned needs a decision. _(per knowledge/decisions/0009-build-dispatch-runner-git-credentials.md#context)_
- Because the runner pushes with its own git credentials and specd holds none, the server cannot clean up a half-pushed branch left by a dead runner — any cleanup must be performed by the reclaiming runner itself. _(per knowledge/decisions/0009-build-dispatch-runner-git-credentials.md#why-this-rather-than-minting-tokens)_
- `local`-provider repositories are not dispatchable and keep running in-process, so reclaim logic applies only to rows that were dispatched to a runner and must not touch in-process runs. _(per knowledge/decisions/0009-build-dispatch-runner-git-credentials.md#what-this-costs-stated-plainly)_
- Concrete lease-timeout values (e.g. 2 minutes for `spec`/`onboard`, 15–30 minutes for `build`) and the daemon's actual heartbeat interval are not established by any excerpt provided. _(**UNVERIFIED** — confirm the runner daemon's heartbeat interval and agree per-kind lease durations with the runner maintainer)_
- The maximum reclaim count before a run is marked permanently failed, and the exact user-facing retry affordance in the UI, are not grounded in any excerpt. _(**UNVERIFIED** — confirm reclaim-attempt cap and the run/spec failure UX with the product owner)_
- Whether `agent_runs` needs new columns (e.g. `lease_expires_at`, `reclaim_count`) versus deriving everything from `claimed_at` + `runners.last_seen_at` requires reading the current schema. _(**UNVERIFIED** — confirm against packages/db/src/schema.ts and decide whether a migration is required)_

### Out of scope

- Per-runner concurrency — a runner still takes one job at a time.
- Retry policy for jobs that fail legitimately (model error, verify failure); this covers only jobs nobody is working on.
- Hosted, fleet-owned ephemeral runners and any per-job token-minting design.
- Replacing the polling claim protocol with a real queue (BullMQ), which remains unwired.
- Detecting or evicting a paired-but-idle runner from the runners table.

## Tasks

- [ ] **T1** Add lease/reclaim fields to agent_runs (or confirm none needed) + migration, and per-kind lease timeout config — _S · unitypark/specd_
- [ ] **T2** Widen RunnerJobsService.claim() raw-SQL predicate to reclaim expired-lease running jobs, preserving FOR UPDATE SKIP LOCKED; add concurrency test proving no double-claim — _M · unitypark/specd_
- [ ] **T3** Enforce runner ownership on POST /runners/jobs/:id/report and /progress; reject stale reporters — _S · unitypark/specd_
- [ ] **T4** Emit reclaim events into the run log so the SSE viewer shows takeover; cap reclaim attempts and fail the run when exhausted — _M · unitypark/specd_
- [ ] **T5** Runner-side handling for a reclaimed build: fresh checkout, up-front push-access check, safe handling of a prior partial branch — _M · unitypark/specd_
- [ ] **T6** Update docs/runners.md to remove the no-lease-timeout known gap and document lease/reclaim behaviour — _S · unitypark/specd_
- [ ] **T7** commit as-built spec → knowledge/specs/S-101-reclaim-jobs-abandoned-by-a-dead-runner.md — _S · unitypark/specd_

## Open questions

- What is the runner daemon's heartbeat interval, and is `runners.last_seen_at` written on every poll or only on a dedicated heartbeat call?
- What lease timeout per job kind (spec/onboard vs build) is acceptable given the worst-case legitimate build duration?
- For a reclaimed build, what happens to work the dead runner already pushed — reuse the branch, force-update it, or start a new one? specd holds no git credential, so only the reclaiming runner can act on it.
- How many reclaims before a run is marked permanently failed, and what does the user see/do then?
- Should a runner that is reclaimed-from be marked unhealthy or unpaired, or left alone to reconnect?

## Verification

`pnpm typecheck && pnpm test` — passed

## Deviations

- **Reclaim requires both signals stale, not heartbeat alone.** Requirement 1
  reads "heartbeat older than the lease → eligible"; as built, the job's
  `claimed_at` must also be older than the lease. Heartbeat-only would let a
  just-claimed job be taken during a brief network flap; the WHILE-heartbeating
  criterion is unaffected.
- **A runner may reclaim its own running job without the heartbeat check.**
  The daemon runs one job at a time, so the owner polling for new work means
  it crashed and restarted — and its own polling keeps its heartbeat fresh,
  which would otherwise block that recovery forever. Not anticipated by the
  spec; surfaced by reading the daemon.
- **The daemon now heartbeats while executing** (`SPECD_RUNNER_HEARTBEAT_MS`,
  default 30s). The spec's open question 1 assumed liveness was already
  observable mid-job; it was not — a model call is minutes of silence. Without
  this, any heartbeat-based lease reclaims from healthy runners.
- **Open-question defaults chosen at build time:** leases 180s (spec/onboard)
  and 900s (build), reclaim cap 3, all env-tunable; a reclaimed-from runner is
  left paired (eviction stays out of scope); a zombie build's late force-push
  is documented as a known race in docs/runners.md rather than prevented —
  specd holds no git credential to prevent it (decision 0009).
