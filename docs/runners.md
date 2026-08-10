# Self-hosted runners

**Status: pairing + spec/onboard/build dispatch.** A machine can prove itself
to a project, receive a credential, and be handed `spec`, `onboard` and
`build` jobs to execute with its own local Claude Code. Builds additionally
clone and push with the machine's own git credentials — see "Builds" below.

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
default 5s). When a `spec` or `onboard` job is queued for this project, it
drives the local `claude` CLI the same way `subscription_runner` mode does
when specd runs beside a logged-in Claude Code, then reports the parsed
result back with `POST /runners/jobs/:id/report`. It never touches the
database or the knowledge index — the server does all of that on either side
of the daemon's one job: drive the model and hand back a parsed reply. For
`onboard` specifically, that is true even of the git side —
`OnboardingAgent`'s clone/propose calls are VCS REST API requests with a
platform-held token, not a real checkout, so they never needed to move to
the runner at all; only the drafting model call did.

`build` jobs are the exception and need `git` on PATH; see "Builds" below.

The `PipelineService`/onboarding station both pick a paired runner
automatically whenever a project's AI mode is `subscription_runner` and a
runner is paired to it — no runner picked, no dispatch: the existing
synchronous path (specd's own process shelling out to a local `claude`)
runs exactly as before.

## Builds

A `build` job is the one kind that does not reduce to "call the model, hand
back JSON": each task's model call edits files the next one reads, so the
whole loop — clone, edit, commit, verify, file the as-built spec, push —
runs on the runner. The server still chooses what to build, renders the
prompts, meters the spend, and opens the pull request.

**The runner needs its own git access to the repository, and specd does not
give it any.** No token is sent, none is stored in the job payload, and the
daemon never asks for one. It runs `git clone` and `git push` as whoever owns
the machine, using the git configuration already there — the same shape as
subscription mode, where the runner drives its own logged-in Claude Code and
specd never sees that credential either
(`knowledge/decisions/0009-build-dispatch-runner-git-credentials.md`).

In practice that means a runner is a machine your team already trusts with
the code: a developer's laptop or a build box. Two consequences worth
knowing:

- **Access is checked before the first model call**, with `git ls-remote`. A
  machine that cannot push fails in seconds rather than after a full build's
  worth of tokens.
- **Prefer SSH?** Configure it in git, not in specd — specd sends an HTTPS
  clone URL and git rewrites it for you:
  ```bash
  git config --global url."git@github.com:".insteadOf "https://github.com/"
  ```

`local`-provider repositories are never dispatched: their path is on the API
host's disk and means nothing on another machine, so they keep building
in-process. If a runner is paired but the primary repo is local, the run says
so and builds on the server.

While a build runs, the daemon posts each line of its narration to
`POST /runners/jobs/:id/progress`, so the run's live log in the app shows the
same thing the runner's console does. Losing that connection never fails the
build — the commentary is best-effort, the work is not.

## Leases and reclaim (S-101)

A claimed job carries a lease. If the owning runner goes silent past it, the
job becomes claimable again — by another runner, or by the same one after a
restart — instead of hanging `running` forever.

How liveness works: every authenticated call a runner makes bumps its
`last_seen_at`, and while executing a job the daemon also heartbeats on an
interval (`SPECD_RUNNER_HEARTBEAT_MS`, default 30s), because a model call is
minutes of legitimate silence. Reclaim requires **both** signals stale — the
job out longer than its kind's lease *and* the owner unheard-of for that
long — so neither a long model call nor a just-claimed job can be taken from
a healthy runner. The one exception: a runner may reclaim **its own**
running job without the heartbeat check, since a single-job daemon polling
for new work while it still owns one means it crashed and restarted — and
its own polling keeps its heartbeat fresh, which would otherwise block that
recovery forever.

Builds get a longer lease than spec/onboard drafts
(`SPECD_RUNNER_LEASE_BUILD_SECONDS`, default 900, vs
`SPECD_RUNNER_LEASE_SECONDS`, default 180): reclaiming a build that was
merely slow wastes N model calls and a checkout, not one call.

What a reclaim does: the claim switches ownership atomically (the same
`FOR UPDATE SKIP LOCKED` guarantee — two pollers can never both win),
increments the job's reclaim count, and writes a `warn` line to the run log
so the takeover is visible in the app: *"reclaimed from unresponsive runner
X — re-running from scratch."* Spec and onboard jobs replay their stored
payload identically. A reclaimed **build** starts from a fresh checkout on
the new runner and force-pushes its branch on completion — the branch
belongs to the spec, not to an attempt at it.

The zombie case: a runner that lost its lease and later wakes up gets a 403
on `report` and `progress` — the run is not mutated, and only the new
owner's report counts. One race is documented rather than prevented: a
zombie *build* still holds its own git credentials and could force-push the
branch after the winner did. specd holds no credential to stop that
(decision 0009); the PR review still gates what merges.

After `SPECD_RUNNER_MAX_RECLAIMS` takeovers (default 3), a still-expiring
job is **failed** with "repeatedly abandoned" rather than dispatched again —
a job three runners died holding is a crash loop, not bad luck. The run's
spec stays in a retryable state: press Build (or Generate) again once a
runner is healthy.

## What is not built yet

- **Concurrency.** The daemon claims and runs one job at a time. A runner
  with capacity to spare has no way to say so.

## Reference

| Route | Caller | Auth |
|---|---|---|
| `POST /projects/:slug/runners` | Project member (owner/maintainer) | user token |
| `GET /projects/:slug/runners` | Project member (owner/maintainer/reviewer) | user token |
| `DELETE /projects/:slug/runners/:id` | Project member (owner/maintainer) | user token |
| `POST /runners/pair` | The runner | none — the pairing code *is* the credential |
| `POST /runners/heartbeat` | The runner | runner bearer token |
| `POST /runners/jobs/claim` | The runner | runner bearer token |
| `POST /runners/jobs/:id/progress` | The runner | runner bearer token |
| `POST /runners/jobs/:id/report` | The runner | runner bearer token |

The runner token is hashed (SHA-256) at rest, not encrypted — it is a
256-bit random value, not a secret a person chose, so there is nothing a
slow, salted hash would protect that the token's own entropy does not
already provide, and a fast digest is the correct tool for comparing a
presented bearer token against a stored one on every request.
