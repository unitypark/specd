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

## What is not built yet

- **Concurrency.** The daemon claims and runs one job at a time. A runner
  with capacity to spare has no way to say so.
- **Retry/backoff on daemon crash.** A job claimed by a runner that then
  dies stays `running` forever — there is no lease timeout that would let
  another runner (or the same one, restarted) reclaim it. This matters more
  for builds than for spec drafts, simply because they run for longer.

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
