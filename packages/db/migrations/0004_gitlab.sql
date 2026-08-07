-- GitLab support (§11): a repository's webhook is registered per-project via
-- the GitLab API at add-time, not once for a whole App the way GitHub's is.
-- That registration can fail — a read-only token, a role below Maintainer, an
-- unreachable self-managed instance — and it must fail into a state the UI
-- can show honestly rather than a silent gap the merge-detection story quietly
-- depends on. `setup_state`/`kb_status` already track pipeline state this way
-- on the same row; this follows the same convention.

ALTER TABLE repositories
  ADD COLUMN IF NOT EXISTS webhook_status text NOT NULL DEFAULT 'none';
-- none       — no webhook needed (local) or not attempted yet
-- registered — GitLab confirmed the webhook; merges will be detected
-- failed     — registration was attempted and refused; see the repository's
--              most recent gitlab delivery/registration error in the logs
