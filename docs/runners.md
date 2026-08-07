# Self-hosted runners

**Status: pairing + spec dispatch.** A machine can prove itself to a
project, receive a credential, and be handed `spec`-drafting jobs to
execute with its own local Claude Code. `onboard`/`build` dispatch (which
need a git checkout on the runner) are not built yet — see "What is not
built yet" below.

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

## Run the daemon

Once a machine is paired, start the daemon that actually polls for and
executes work — `apps/runner`, published as `@specd/runner` with a
`specd-runner` bin:

```bash
SPECD_RUNNER_TOKEN=$(specd runner token) SPECD_API=http://localhost:4000/api \
  pnpm --filter @specd/runner start
```

It polls `POST /runners/jobs/claim` on an interval (`SPECD_RUNNER_POLL_MS`,
default 5s). When a job is queued for this project, it drives the local
`claude` CLI the same way `subscription_runner` mode does when specd runs
beside a logged-in Claude Code, then reports the parsed result back with
`POST /runners/jobs/:id/report`. It never touches the database or the
knowledge index directly — the server does all of the DB-dependent work
(retrieval, prompt assembly, and after the fact, saving the resulting spec
version) on either side of the daemon's one job: drive the model and hand
back a parsed reply.

The `PipelineService` picks a paired runner automatically whenever a
project's AI mode is `subscription_runner` and a runner is paired to it —
no runner picked, no dispatch: the existing synchronous path (specd's own
process shelling out to a local `claude`) runs exactly as before.

## What is not built yet

- **`onboard`/`build` dispatch.** Those job kinds need a git checkout on the
  runner's own machine (clone, branch, push) — spec drafting needs none of
  that, which is why it shipped first. The queue/claim/report protocol
  already generalizes to other job kinds; only the runner-side git handling
  and the corresponding `prepare`/`finalize` split for those agents are
  missing.
- **Concurrency.** The daemon claims and runs one job at a time. A runner
  with capacity to spare has no way to say so.
- **Retry/backoff on daemon crash.** A job claimed by a runner that then
  dies stays `running` forever — there is no lease timeout that would let
  another runner (or the same one, restarted) reclaim it.

## Reference

| Route | Caller | Auth |
|---|---|---|
| `POST /projects/:slug/runners` | Project member (owner/maintainer) | user token |
| `GET /projects/:slug/runners` | Project member (owner/maintainer/reviewer) | user token |
| `DELETE /projects/:slug/runners/:id` | Project member (owner/maintainer) | user token |
| `POST /runners/pair` | The runner | none — the pairing code *is* the credential |
| `POST /runners/heartbeat` | The runner | runner bearer token |
| `POST /runners/jobs/claim` | The runner | runner bearer token |
| `POST /runners/jobs/:id/report` | The runner | runner bearer token |

The runner token is hashed (SHA-256) at rest, not encrypted — it is a
256-bit random value, not a secret a person chose, so there is nothing a
slow, salted hash would protect that the token's own entropy does not
already provide, and a fast digest is the correct tool for comparing a
presented bearer token against a stored one on every request.
