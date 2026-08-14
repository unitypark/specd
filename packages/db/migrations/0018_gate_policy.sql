-- House rules on the gate, as data rather than as a code change.
--
-- The gate is binary today: approved or not. Teams want more than that — "do
-- not build below 60% knowledge health", "a spec with eight UNVERIFIED claims
-- is not ready for a reviewer" — and the only way to express it so far was to
-- edit specd.
--
-- NULL means "no rule", not "zero". A project that never set a floor must not
-- suddenly be held to one, and 0 is a real value someone might choose.
ALTER TABLE projects ADD COLUMN policy_max_unverified integer;
ALTER TABLE projects ADD COLUMN policy_min_health real;
-- Whether a citation that stopped standing since approval refuses the build,
-- rather than only warning in the run log and the PR body. Off by default: an
-- unrelated doc edit should not stop an approved spec from being built unless
-- a team has said it should.
ALTER TABLE projects ADD COLUMN policy_block_on_drift boolean NOT NULL DEFAULT false;

-- Every time a policy was overridden, and by whom.
--
-- This is the half that makes policy worth having. A rule with no way past it
-- gets switched off the first time it is wrong, and a rule with a silent way
-- past it is decoration. So the exception is a first-class record: a named
-- human, a reason they typed, and the rule they set aside.
CREATE TABLE policy_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Nulled, never cascaded: the audit trail outlives the work it describes,
  -- the same way run history and webhook deliveries already do.
  spec_id uuid REFERENCES specs(id) ON DELETE SET NULL,
  run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  ticket_key text NOT NULL,

  -- Which rule was set aside, and what it would have refused.
  policy text NOT NULL,
  detail text NOT NULL,

  -- Who took responsibility. Both are required by the CHECK below, for the
  -- same reason an approved spec cannot exist without an approver: an
  -- unattributed exception is indistinguishable from the rule never having run.
  approved_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_by_name text NOT NULL,
  justification text NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT policy_exception_is_attributed
    CHECK (length(btrim(approved_by_name)) > 0 AND length(btrim(justification)) > 0)
);

CREATE INDEX policy_exceptions_project_idx
  ON policy_exceptions (project_id, created_at DESC);
