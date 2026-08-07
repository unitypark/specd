# 0004 — Runner job dispatch: prepare/finalize split, atomic claim, spec-only scope

- **Status:** accepted
- **Date:** 2026-08-07
- **Project:** specd

## Context

[[0003-runner-pairing-before-dispatch]] shipped pairing and explicitly
deferred dispatch — a paired runner had a credential but nothing to do with
it. This decision covers the dispatch mechanism itself: how a job reaches a
runner, how its result gets back into a spec, and why the scope is `spec`
jobs only for this pass.

A runner is a separate process on a separate machine with no database
access — by design (§9), it should never need direct Postgres/pgvector
credentials just to draft a spec. Everything DB-dependent (knowledge
retrieval, prompt assembly, and later, saving the resulting spec version)
therefore has to happen on the server, on either side of the one thing only
the runner can do: drive its own local, already-logged-in `claude` CLI.

## Decision

**Prepare/finalize split.** `SpecAgent.draft()` (the existing synchronous
path) was split into `prepare()` (retrieval + prompt assembly, all
DB-dependent, returns a `PreparedSpecCall`) and `finalize()` (pure —
normalizes an already-parsed reply against already-retrieved chunks). `draft()`
now just calls `prepare()` → `ModelRouter.call()` → `finalize()` in sequence,
unchanged in behavior. `PipelineService.generateSpec()` calls `prepare()`
directly when a runner is paired, stores the prepared prompt+schema as an
opaque `jobPayload` on the `AgentRun` row, and returns `{queued: true}`
instead of a spec. When the runner reports back, `RunnerJobsService.report()`
calls `finalize()` and creates the spec version — the same normalization
invariants (as-built task auto-append, citation validation) apply on both
the synchronous and dispatched paths because they share the same code.

**Atomic claim via raw SQL.** `RunnerJobsService.claim()` uses
`UPDATE agent_runs SET runner_id = ..., status = 'running' WHERE id = (SELECT
... FOR UPDATE SKIP LOCKED) RETURNING ...` through `DB_HANDLE`'s raw
`postgres.Sql` client, mirroring `KnowledgeService`'s existing precedent for
queries Drizzle's query builder cannot express. This is the standard
Postgres queue-claiming idiom — it guarantees two runners polling
concurrently never claim the same job, without a separate lock table or
application-level mutex.

**SHA-256 for runner tokens**, reused from pairing (0003) rather than
introduced fresh — the reasoning does not change for job-claim tokens: a
256-bit random value being compared, never decrypted, needs a fast digest,
not `Vault` or scrypt.

**Scoped to `spec` jobs only.** `onboard`/`build` need a git checkout
(clone, branch, push) on the runner's own machine — meaningfully more
runner-side infrastructure than "drive `claude`, return JSON." Spec drafting
needs none of that, so it shipped first; the queue/claim/report protocol
(`agent_runs.runner_id`/`claimed_at`/`job_payload`, `POST
/runners/jobs/claim`, `POST /runners/jobs/:id/report`) is not spec-specific
and should generalize to other job kinds without a schema change, once their
own `prepare`/`finalize` splits and runner-side git handling exist.

**The runner daemon (`apps/runner`, `@specd/runner`)** duplicates
`ClaudeCodeProvider`'s `spawn('claude', ...)` invocation logic rather than
sharing it — the daemon runs on a different machine than the API with no
NestJS DI container to plug a shared provider into, and the two call sites
are small enough (~150 lines) that forcing a shared abstraction across a
process boundary was judged not worth the indirection. The pure JSON
extraction/repair/schema-check logic (`packages/shared/src/claude-code-parse.ts`)
*is* shared, since that part has no framework dependency either side.

## Consequences

- A runner never touches the database or the knowledge index — it receives
  an opaque `{system, user, schema, model, maxTokens}` job and returns a
  parsed reply or an error. The trust boundary is exactly the boundary
  pairing already established: a runner is a machine executing work handed
  to it, not a peer with its own data access.
- `ModelRouter.describeMode('subscription_runner', projectId)` now checks
  for a paired runner before falling back to "is `claude` on this
  machine's PATH" — a hosted specd with no local Claude Code of its own can
  still offer subscription mode, as long as a runner is paired.
- Any future job kind's dispatch support is "add a `prepare`/`finalize`
  split to that agent, add a payload shape, teach `RunnerJobsService.report`
  to route on `run.kind`" — not a new queue or protocol.
- Known gaps, tracked in `docs/runners.md`: no lease timeout (a runner that
  crashes mid-job leaves it stuck `running` forever), no per-runner
  concurrency, `onboard`/`build` dispatch unimplemented.

## Addendum (2026-08-08) — the `exec()` hang

A real, in-process build hung for 30+ minutes with no error: `ClaudeCodeProvider.exec()`
(and its duplicate in `apps/runner/src/claude.ts`) only ever resolved its
promise on the child process's `close` event. The internal timeout only sent
SIGTERM/SIGKILL — it never force-resolved the promise itself — so a killed
process that left its stdio pipes open (a grandchild inheriting the write
end, a known Node `child_process` gotcha) hung the `await` forever regardless
of the timeout firing. Fixed in both copies with a bounded backstop: once a
kill signal is actually sent, a second timer force-resolves using whatever
`exit` last reported, rather than waiting indefinitely on a `close` that may
never come. Regression-tested in `apps/runner/src/claude.test.ts` against a
fake `claude` binary that reproduces exactly this (backgrounds a process that
inherits stdout and outlives the parent).
