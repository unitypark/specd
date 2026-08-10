<!-- Filed automatically by specd when S-103 was built. -->
<!-- This is a historical record: never rewrite it. If reality later -->
<!-- diverged, append a "## Deviations" section below.              -->
# S-103 — Prune webhook delivery records older than 30 days

> spec v2 · status: approved
> approved by Theo on 2026-08-07T04:27:03.071Z

## Requirements

### As a specd operator, I want webhook delivery records older than 30 days automatically deleted so that the table stays bounded without manual intervention.

- **WHEN** the retention prune job runs **THE SYSTEM SHALL** delete all webhook_deliveries rows with a received/created timestamp older than 30 days.
- **WHEN** the retention prune job completes **THE SYSTEM SHALL** log the count of rows deleted.
- **WHEN** the retention prune job runs and no rows are older than 30 days **THE SYSTEM SHALL** log a count of zero rather than skipping the log entry.
- **IF** the prune query fails (e.g. database unreachable) **THE SYSTEM SHALL** log the failure with enough detail to diagnose it and SHALL NOT crash the host process.
- **WHILE** the prune job is deleting a large batch of rows **THE SYSTEM SHALL** avoid holding a single long-running transaction that blocks concurrent webhook inserts.
- **WHEN** a webhook delivery row is exactly 30 days old at prune time **THE SYSTEM SHALL** retain rows not yet older than the 30-day cutoff and delete only rows strictly older than it.

### As an engineer investigating a past incident, I want deliveries from the last 30 days to remain queryable so that I can answer "why did specd do that last week".

- **WHEN** a delivery record is within the 30-day retention window **THE SYSTEM SHALL** keep it queryable via existing webhook delivery lookups.
- **IF** the retention period is changed in configuration **THE SYSTEM SHALL** apply the new period to subsequent prune runs without requiring a code change to the prune logic itself.

## Design

- webhook_deliveries rows are deduplicated by delivery id and matched to a project by repo+installation; the prune job deletes by age only and must not alter this dedup/match behaviour for retained rows. _(per knowledge/architecture.md#invariants-claimed-to-be-enforced-in-code)_
- The migration comment in packages/db/migrations/0003_github_webhooks.sql already documents an intent to prune by age; this spec implements that stated intent rather than introducing a new policy. _(**UNVERIFIED** — confirm exact column name and comment wording in packages/db/migrations/0003_github_webhooks.sql — not shown in retrieved knowledge excerpts)_
- Deletion should run as a scheduled job (e.g. cron-style) rather than on the request path, deleting in batches to avoid a long-running transaction that blocks webhook ingest inserts. _(**UNVERIFIED** — ask the API team whether apps/api already has a job/scheduler mechanism (e.g. Nest scheduler) to hook into, or whether this needs a new one)_
- Deletion count must be logged (not silently dropped), consistent with the project's convention that skipped/automated work is labelled rather than passed silently. _(per knowledge/conventions.md#writing-conventions-the-product-itself-enforces)_
- Webhook-related tests, including any new prune test, should skip themselves when Postgres is unreachable so the suite stays green on a machine with no infra. _(per knowledge/conventions.md#testing)_
- knowledge/ documentation (e.g. the migration comment or a runbook note) describing this retention behaviour should be updated in the same PR as the code. _(per knowledge/README.md#how-this-stays-alive)_

### Out of scope

- Making the 30-day retention period user-configurable via UI or per-project settings
- Archiving pruned rows to cold storage before deletion
- Pruning any table other than webhook_deliveries
- Backfilling/pruning historical data as a one-time migration separate from the recurring job

## Tasks

- [ ] **T1** Add scheduled prune job: delete webhook_deliveries older than 30 days, log deleted count — _M · unitypark/specd_
- [ ] **T2** Add tests for prune job (boundary at 30 days, zero-row case, failure logging), skipping when Postgres unreachable — _S · unitypark/specd_
- [ ] **T3** Update migration comment / knowledge docs to reflect implemented retention behaviour — _S · unitypark/specd_
- [ ] **T4** commit as-built spec → knowledge/specs/S-103-prune-webhook-delivery-records-older-than-30-day.md — _S · unitypark/specd_

## Open questions

- Which column holds the delivery timestamp used for the age cutoff, and is it indexed (needed to prune efficiently without table scans)?
- Does apps/api already have a scheduling mechanism (Nest cron/scheduler) to hook this job into, or must one be introduced?
- What log sink/format should the deletion count be written to — existing structured logger, or a new metric?
- Should the prune run in batches, and what batch size avoids lock contention on a live table?
- Ticket body contains no attempted instructions to the agent, but confirm no injected directives were stripped by upstream tooling before this review — none observed in the retrieved text.

## Verification

`pnpm typecheck && pnpm test` — not run

## Deviations

- **Built twice.** The original build (PR #12, 2026-08-07) went stale before
  merging — 27 merges of engine work landed under it, including the webhook
  services it patched — and was closed unmerged on 2026-08-11. This file
  records the re-implementation (same approved spec, verbatim above) against
  that later codebase. The closed branch is kept for reference.
- **The open questions all answered cleanly on the later main.** The cutoff
  column is `received_at`, indexed since `0003` — no new index was needed. No
  scheduler existed; the prune follows the in-process worker pattern
  [[0012-index-runs-queued-and-woken-by-listen-notify]] established (an
  `OnModuleInit` service with an interval), not a new mechanism. The log sink
  is the ordinary Nest logger. Batch size 500, each batch its own statement —
  which satisfies the no-long-transaction requirement by construction.
- **The prune also runs at startup**, not only on the interval. An interval
  alone never fires in a process that restarts more often than it ticks —
  which is every dev laptop, and a daily-deploy server too.
- **No cross-instance coordination, deliberately.** Two API instances pruning
  concurrently delete disjoint rows; a lock would add a failure mode to
  remove a harmless overlap. Recorded here because the multi-instance work
  (2026-08-10) made this a real configuration rather than a hypothetical.
- **"Queryable via existing lookups" is verified by row presence** in the
  retention tests rather than by driving the full webhook service, whose
  constructor drags in five unrelated dependencies. The lookups read the same
  rows; nothing about them changes.
- **The UNVERIFIED design item is confirmed:** `0003_github_webhooks.sql` did
  document the prune-by-age intent ("pruned by age rather than never"), and
  its comment now names the implementation. Editing an applied migration's
  comment is safe — the runner tracks migrations by filename only.
- **One bug found during re-implementation:** the first version passed the
  cutoff as a `Date` into raw SQL, which this pool cannot serialize; the
  fail-soft catch then made the error look identical to an empty table. The
  failure-logging test the spec required is what surfaced it.
