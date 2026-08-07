# Self-hosted runners

**Status: pairing only.** This document describes what is actually built —
a machine can prove itself to a project and receive a credential. It cannot
yet be dispatched a job. See "What is not built yet" below before assuming
more than that.

A runner is a machine, not a user. It pairs with a project using a short
code — the same shape `specd login`'s device flow uses for a human at a
browser, adapted for a headless process that has no session to present.

---

## Why this exists

Claude subscription mode (D2) only works where specd itself runs beside an
already-logged-in Claude Code — the platform shells out to the local `claude`
binary and never sees, stores or proxies the subscription credential. That is
the entire trust story, and it means a *hosted* specd cannot offer
subscription mode at all: there is no local Claude Code to shell out to.

A self-hosted runner is what closes that gap — a machine you control, paired
to a project, that can eventually be handed onboarding/spec/build jobs to run
with its own local credentials. Pairing is the first half: proving the
machine belongs to the project and giving it a credential of its own.

## Pair a runner

**1. Generate a pairing code**, from the project's Settings page (owner or
maintainer). It is shown once — copy it now:

```
5VXCK-7UYZC
```

**2. Run the pair command** on the machine you want to pair:

```bash
specd runner pair 5VXCK-7UYZC
```

This does three things in one step, and reports on all three:

```
Paired with project aurora-crm.
Runner token stored in your login keychain.
Outbound connectivity to the API: OK.
```

- Exchanges the code for a runner token (`POST /runners/pair`) — single use,
  and expires after 30 minutes if never redeemed, the same way an unused
  device-login code does.
- Stores the token in the OS keychain on macOS, or a `0600` file under the
  config directory elsewhere — in a **separate** slot from a signed-in
  user's own CLI token, so pairing a runner on a machine that is also
  `specd login`-ed as a person cannot overwrite that person's session.
- Calls `POST /runners/heartbeat` once immediately, so a bad network path or
  firewall rule is caught right here rather than discovered later on a job
  that silently never starts.

## Managing runners

Project Settings lists every runner: paired or still awaiting its first
pairing, and how long since it was last heard from. Removing one from there
revokes it immediately — its stored token stops authenticating on the very
next request, there is no grace period.

## What is not built yet

Pairing proves a machine and hands it a credential. **Nothing yet asks that
machine to do anything.** Specifically absent:

- **A job queue.** Every agent run today — hosted or not — executes
  synchronously inside the API process. `AgentRun.runner` is a label for the
  billing/observability story (subscription quota vs. metered tokens), not a
  dispatch target.
- **A job-claim/report protocol.** There is no `GET /runner/jobs`,
  no claim, no way for a paired runner to be told "draft this spec" or
  "build this branch" and hand results back.
- **The runner daemon itself** — the long-running process that would poll
  for jobs and execute them locally (shelling out to the runner's own
  `claude` binary, cloning and pushing with git the way the hosted build
  station already does, just on the runner's own machine instead of the
  platform's). `specd runner pair` completes the handshake and stops there.

`specd runner pair` is genuinely useful today on its own — it is the
diagnostic step ("is this code valid, is this machine reachable, is the
token good") that any dispatch protocol will need regardless of its final
shape. It is not, yet, a way to actually run anything.

## Reference

| Route | Caller | Auth |
|---|---|---|
| `POST /projects/:slug/runners` | Project member (owner/maintainer) | user token |
| `GET /projects/:slug/runners` | Project member (owner/maintainer/reviewer) | user token |
| `DELETE /projects/:slug/runners/:id` | Project member (owner/maintainer) | user token |
| `POST /runners/pair` | The runner | none — the pairing code *is* the credential |
| `POST /runners/heartbeat` | The runner | runner bearer token |

The runner token is hashed (SHA-256) at rest, not encrypted — it is a
256-bit random value, not a secret a person chose, so there is nothing a
slow, salted hash would protect that the token's own entropy does not
already provide, and a fast digest is the correct tool for comparing a
presented bearer token against a stored one on every request.
