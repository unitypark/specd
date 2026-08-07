# 0003 — Ship runner pairing before job dispatch, as two separate changes

- **Status:** accepted
- **Date:** 2026-08-07
- **Project:** specd

## Context

Remote runner pairing is the last unimplemented P2 item on the roadmap
(`SPEC-PLATFORM-PLAN.html` §14): a self-hosted runner that pairs via a short
code and polls the API outbound-only, so a hosted specd can dispatch
onboarding/spec/build jobs to a customer's own machine. The `runners` table
(`packages/db/src/schema.ts`) already anticipated the shape — `pairCode`,
`pairedAt`, `lastSeenAt`, `tokenHash` — but nothing read or wrote it.

Investigating what "pairing" actually requires surfaced that it is really two
separate, differently-sized pieces of work bundled under one name:

1. **Pairing** — a machine proves itself to a project and receives a
   credential. Schema-ready, and the CLI's existing device-code login
   (`AuthService.startDeviceFlow`/`pollDeviceCode`) is a close structural
   precedent: a short human code, a longer secret, single-use exchange.
2. **Job dispatch** — a paired runner is actually handed work and reports
   results. This needs infrastructure that does not exist anywhere in the
   codebase today: a real job queue (Redis/BullMQ is provisioned in
   `docker-compose.yml` but never wired into any code — `PipelineService`
   runs every station synchronously in-process, per its own comment: "the
   BullMQ worker in `queue/` takes over... in P2," and no `queue/` directory
   exists), a job-claim/report HTTP protocol, a runner-scoped auth model
   broader than the CLI's deliberately narrow "thin client" tokens (D13), and
   — the largest piece — moving `ClaudeCodeProvider`'s `spawn('claude', ...)`
   invocation and `WorkspaceService`'s git clone/push logic to run on the
   runner's own machine instead of the API process, since today "subscription
   mode" only works because the API process and the local `claude` binary
   happen to be the same machine.

## Decision

Ship (1) as a complete, mergeable unit now. Explicitly defer (2) rather than
attempt both under one change — the two pieces have almost no shared
implementation surface once pairing itself is done, and starting job dispatch
without first deciding its own shape (see the follow-up decision on daemon
language) risks wasted work.

Pairing mirrors the device-code flow's shape but is a genuinely separate
mechanism, not a reuse of it: a runner is a machine, not a user, so it cannot
reuse `TokenClaims`/`aud: 'cli'` (scoped to user identity) or JWT-based
verification. Its token is a high-entropy random value hashed with SHA-256
(fast, one-way) rather than scrypt (slow, for low-entropy human secrets) or
`Vault` (reversible envelope encryption, for credentials that must later be
decrypted and used — a runner token is only ever compared, never recovered).

The runner daemon that will eventually consume job dispatch is a **Node
program**, not a second mode of the Go CLI binary — reusing
`ClaudeCodeProvider`/`WorkspaceService`/the agent classes nearly as-is
(refactored to talk to the API over HTTP instead of injecting Drizzle
directly) is a far smaller lift than porting that same spawn/git logic to Go.
The CLI stays a thin, single-binary client (D13); the runner is a distinct,
heavier program, matching the plan's own `docker run specd/runner` framing —
a container hides the runtime either way.

## Consequences

- `specd runner pair <code>` is genuinely useful today, standing alone: it
  validates the code, stores a credential, and proves outbound connectivity
  — the exact diagnostic step any future dispatch protocol needs regardless
  of its final shape.
- It does not run anything. `docs/runners.md` says so plainly, because the
  wizard/CLI/docs together must not imply more than what is built (the same
  guardrail applied to every generated-artifact claim elsewhere in this
  project).
- Job dispatch, when it lands, is a second PR with its own design pass:
  the queue, the claim/report protocol, and the Node runner daemon. This
  decision record exists so that work starts from a stated shape rather than
  re-deriving it.