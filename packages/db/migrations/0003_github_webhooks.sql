-- GitHub webhook deliveries.
--
-- GitHub redelivers: on its own retry schedule, and on demand from the
-- Advanced tab when someone is debugging. A redelivered "PR merged" must not
-- re-run the index or re-log the merge, so every delivery is recorded by the
-- id GitHub assigns it and the primary key does the deduplication. The insert
-- is ON CONFLICT DO NOTHING — losing the race means somebody else already
-- handled it.
--
-- Rows are kept because they are the audit trail for "why did specd do that at
-- 03:00" (§10), and pruned by age rather than never.

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  -- The X-GitHub-Delivery uuid. Not defaulted: it must come from GitHub.
  id             uuid PRIMARY KEY,
  provider       text NOT NULL DEFAULT 'github',
  event          text NOT NULL,
  action         text,
  installation_id text,
  repo_full_name text,
  project_id     uuid REFERENCES projects(id) ON DELETE SET NULL,
  -- What we decided to do, and why — readable months later without the payload.
  outcome        text NOT NULL,
  detail         text,
  received_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webhook_deliveries_received_idx
  ON webhook_deliveries (received_at DESC);
CREATE INDEX IF NOT EXISTS webhook_deliveries_project_idx
  ON webhook_deliveries (project_id, received_at DESC);
