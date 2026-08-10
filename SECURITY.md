# Security policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report privately via [GitHub security advisories](https://github.com/unitypark/specd/security/advisories/new)
("Report a vulnerability" on the Security tab). You will get an acknowledgment,
and fixes land as ordinary PRs once there is something safe to say publicly.

## Supported versions

specd is pre-1.0. Only the latest `main` is supported — there are no release
branches to backport to yet.

## What is most worth your attention

The parts of specd with real security surface, so a review knows where to look:

- **The credential vault** (`apps/api/src/common/vault.ts`) — VCS and tracker
  tokens are envelope-encrypted with AES-256-GCM under `VAULT_MASTER_KEY`;
  ciphertext is bound to its project and kind. The master key is not rotatable.
- **Webhook trust boundaries** (`apps/api/src/vcs/*-webhook.verify.ts`) —
  unauthenticated by necessity, guarded by HMAC over raw bytes (GitHub) or a
  constant-time token compare (GitLab). An unset secret rejects everything.
- **The approval gate** — audience-scoped CLI tokens, a state machine, and a
  database CHECK constraint. Anything that lets an agent approve its own input
  or reach an unapproved spec is a vulnerability in the product's core promise.
- **Agent boundaries** — the build agent has editing tools only, never a
  shell; runners never receive platform credentials; run logs are
  secret-scrubbed on the way in.

## Out of scope

- Denial of service against your own local development instance.
- Anything requiring a hostile `VAULT_MASTER_KEY` or `JWT_SECRET` — those are
  the deployment's root of trust by design.
