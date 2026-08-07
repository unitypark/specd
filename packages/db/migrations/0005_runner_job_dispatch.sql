-- Runner job dispatch: a paired runner can be handed a queued agent_run
-- instead of it executing synchronously in the API process. See
-- knowledge/decisions/0003-runner-pairing-before-dispatch.md for why
-- pairing (0004) and dispatch (this one) shipped separately.
--
-- runner_id is set atomically by the claim query (UPDATE ... WHERE
-- runner_id IS NULL ... RETURNING), so two runners racing for the same
-- queued job cannot both win it.

ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS runner_id  uuid REFERENCES runners (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS job_payload jsonb;

CREATE INDEX IF NOT EXISTS agent_runs_queued_idx
  ON agent_runs (project_id, status, runner_id);
