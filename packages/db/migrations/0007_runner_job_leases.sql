-- S-101: reclaim jobs abandoned by a dead runner.
-- The lease itself is derived at claim time from claimed_at (agent_runs) and
-- last_seen_at (runners) — no stored deadline to drift. The only new state is
-- how many times a job has been taken away from an unresponsive runner, which
-- bounds the crash-loop case.
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS reclaim_count integer NOT NULL DEFAULT 0;
