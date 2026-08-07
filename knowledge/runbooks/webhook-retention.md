# Runbook — webhook delivery retention (unitypark/specd)

`webhook_deliveries` rows are the audit trail described in
`packages/db/migrations/0003_github_webhooks.sql` (§10) and are pruned by
age, not kept forever.

## How it works

`WebhookRetentionService` (`apps/api/src/vcs/webhook-retention.service.ts`)
runs on a `setInterval` timer inside the API process:

- Every `SPECD_WEBHOOK_PRUNE_INTERVAL_MS` (default 1h), it deletes rows with
  `received_at` strictly older than `SPECD_WEBHOOK_RETENTION_DAYS` (default
  30) ago.
- Deletes run in batches of 500, each its own short transaction, so a large
  backlog never holds one long-running transaction that blocks concurrent
  webhook inserts.
- Every run logs the total rows deleted, including `0` — a no-op run is
  never silently skipped.
- A failed run (e.g. database unreachable) is logged with the error message
  and left for the next scheduled run; the service never throws out of
  `prune()` and never crashes the host process.

## Changing the retention period

Set `SPECD_WEBHOOK_RETENTION_DAYS` (and optionally
`SPECD_WEBHOOK_PRUNE_INTERVAL_MS`) — see `apps/api/src/config.ts`. No code
change to the prune logic is required.
