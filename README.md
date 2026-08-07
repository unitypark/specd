# specd

**Spec-driven delivery, productized.** Connect your repos, an AI provider and a
tracker; specd grounds a knowledge base in your code, drafts every ticket into a
cited spec, gates it behind a named human, and files the delivered work back into
the knowledge base so the next spec starts better than the last.

> Implementation of `SPEC-PLATFORM-PLAN.html` — P1 scope (§14).

---

## The one rule the whole product enforces

Agents never implement from a bare prompt. They read the project's `knowledge/`
base first, work from a **human-approved** spec, and write what they built back
into the knowledge base in the same PR.

Everything below exists to make that rule true in practice.

```
Connect → Ground → Spec → [HUMAN] → Build → Learn
   01       02       03      04       05      06
                                              └──→ feeds 02
```

The line is fixed (D11). Stations cannot be added, skipped or removed; only
station 01 takes configuration; the gate at 04 is structural.

---

## Quick start

```bash
cp .env.example .env          # dev defaults work as-is
pnpm install
pnpm infra:up                 # Postgres + pgvector, Redis
pnpm db:migrate
pnpm db:seed                  # creates a fixture git repo to onboard

pnpm dev                      # API on :4000, web on :3000
```

Open <http://localhost:3000>, create an account, and run the wizard.

To exercise the whole pipeline headlessly:

```bash
pnpm --filter @specd/api loop
```

That walks Connect → Ground → Spec → gate → CLI handoff → Learn over the real
HTTP API and reports each station. Steps that need a model are **skipped and
labelled**, never silently passed.

### Giving it a model

Three ways in (§P3), and the wizard preflights which of them this machine can
actually do.

**Your Claude subscription** — no API key. specd drives the Claude Code
already signed in on this machine:

```bash
export SPECD_AI_MODE=subscription_runner
pnpm --filter @specd/api loop        # 22 passed, 0 skipped
```

This is D2's self-hosted runner path, and the constraint is the architecture,
not a limitation: specd never sees, stores or proxies a subscription
credential — it shells out to a CLI that is already logged in. A *hosted*
specd therefore cannot offer this mode at all. Runs consume your subscription
quota, so they record tokens but are **not** metered in euros.

Two things it does not inherit from the Messages API, both handled in code:
there is no schema guarantee (the reply is shape-checked, with one repair
attempt before giving up), and there is no per-call billing.

**An API key** — works from anywhere, schema-enforced, metered per token:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

With neither, specd still runs end to end: onboarding writes the template
scaffold (every claim marked `UNVERIFIED`), and spec generation fails with a
clear error rather than inventing content.

---

## Runbook

### Prerequisites

- Node ≥ 22, pnpm `10.32.1` (pinned via `packageManager` — `corepack enable` picks it up)
- Docker, for Postgres + pgvector and Redis (`docker-compose.yml`)

### First run

```bash
cp .env.example .env
pnpm install
pnpm infra:up      # Postgres on :5433, Redis on :6380 (docker compose)
pnpm db:migrate
pnpm db:seed       # writes a fixture git repo to onboard
pnpm dev           # API on :4000, web on :3000
```

`.env` only needs to **exist** — nothing needs sourcing into your shell first.
`apps/api`'s server and `packages/db`'s migration runner both load the
repo-root `.env` themselves before reading anything out of it (the same way
Next.js already does for `apps/web`), so a plain `pnpm dev` right after
`cp .env.example .env` works. Missing `.env` still fails loudly — see
Troubleshooting.

### Restarting

`pnpm dev` runs the API (`--watch`, restarts itself on save) and the web app
(Next.js, fast refresh) in parallel; Ctrl-C stops both. `pnpm infra:up` /
`pnpm infra:down` control Postgres and Redis independently — leave them
running across sessions, there's no reason to tear them down between restarts
of `pnpm dev` itself.

### Verify it's actually up

```bash
curl http://localhost:4000/api/health
open http://localhost:3000
```

### Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `DATABASE_URL is required — copy .env.example to .env` (API), or `db:migrate`'s `DATABASE_URL is not set` | No `.env` at the repo root yet | `cp .env.example .env`, then retry. This is the one thing auto-loading cannot paper over — there is nothing to load. |
| Same error, and `.env` already exists | It's not at the repo root, or the value is empty | `grep DATABASE_URL .env` from the repo root should print a real value — the loader looks there specifically, not at the shell's `cwd`. |
| API can't reach Postgres/Redis (connection refused) | `pnpm infra:up` was never run, or Docker isn't running | `docker ps` should list `specd-postgres` and `specd-redis`, both `healthy`. Run `pnpm infra:up` if not. |
| `EADDRINUSE` on `:3000` or `:4000` | A previous `pnpm dev` is still running elsewhere | `lsof -nP -iTCP:3000 -sTCP:LISTEN` (swap the port), stop that process, then start a new one. |
| A schema-shaped error right after pulling new commits | New migrations landed | `pnpm db:migrate` — idempotent, applies only what's new (tracked in `_specd_migrations`). |
| Web dev server starts 500ing everything after a `pnpm build` | `next build` and `next dev` both write `apps/web/.next`, in incompatible shapes — running the former while the latter is live corrupts it | Don't run `pnpm build` against an `apps/web` a dev server is using. If it already happened: stop the dev server, `rm -rf apps/web/.next`, `pnpm --filter @specd/web dev` again. |

### Resetting

No script wipes data — `pnpm infra:down` is a plain `docker compose down`, so
the named volumes (`specd-pgdata`, `specd-redisdata`) survive it. For a true
reset: `docker compose down -v`, then `pnpm infra:up && pnpm db:migrate && pnpm db:seed`.

---

## What is here

| Path | What it is |
| --- | --- |
| `apps/api` | NestJS API — auth, projects, the pipeline, agents, knowledge index |
| `apps/web` | Next.js — landing, wizard, dashboard, board, spec review, knowledge, runs |
| `cli` | `specd` — Go, single static binary (`pnpm cli:build`) |
| `packages/shared` | Spec lifecycle, EARS rendering, model rate card, cost metering |
| `packages/db` | Drizzle schema + SQL migrations (Postgres + pgvector) |
| `packages/templates` | `AGENTS.md`, `CLAUDE.md` and the `knowledge/` scaffold |

### Stack

Next.js · NestJS · Postgres + pgvector · Redis/BullMQ · Anthropic SDK · Go CLI.
Boring on purpose (§9) — the only interesting decisions are the VCS adapter
split and keeping git as the source of truth for knowledge.

---

## The invariants, and where they are enforced

These are the properties the product sells. Each is enforced in code, not by
convention, and each has a test.

**Only a named human can approve.**
`SpecsService.transition` refuses `approved` without an actor; the state machine
refuses illegal jumps; and a database CHECK constraint rejects an approved row
with no approver, so even a direct write cannot record an unattributed approval.

**The gate cannot be routed around.**
`specd spec pull` is refused server-side for anything unapproved — the CLI is a
thin client (D13) and gets a 409 no matter what it asks for. CLI tokens are
audience-scoped and rejected on every route that authors or approves.

**Approval is not reversible in place.**
Specs are append-only. `approved → draft` is refused; a v2 supersedes v1 while
v1 keeps its recorded approval exactly as it was stamped.

**A citation means someone can check it.**
Every design claim is either cited or flagged `UNVERIFIED`. Citations are
validated against what was actually retrieved — a plausible-looking path the
model invented gets demoted to `UNVERIFIED`, because a citation that cannot be
followed is worse than none: a reviewer skims past it.

**The loop closes.**
The last task of every spec files the as-built copy to `knowledge/specs/`. If
the model omits it, it is appended.

**Spend cannot run away.**
Caps are checked before a run starts, not after it overspends. Cost is metered
per call from the model rate card in EUR cents — integers, so spend never
accumulates float drift.

**Agents never push.**
The build agent gets editing tools only; specd pushes what it produced, and
only ever to the spec's own branch. The write path is that branch plus a pull
request on hosted providers, or a branch you diff in local mode. Nothing writes
to a default branch.

**GitHub cannot be impersonated.**
The webhook endpoint has to be unauthenticated — GitHub has no specd session —
so every delivery is HMAC-verified over the raw bytes in constant time before
the payload is parsed, and an unset secret rejects everything rather than
waving it through. Deliveries are deduplicated by GitHub's delivery id, and an
event is acted on only when its repository *and* installation match a
registered project.

**Neither can GitLab, by the mechanism GitLab actually offers.**
GitLab does not sign the body — a webhook carries a secret token instead,
echoed back verbatim in `X-Gitlab-Token`, compared in constant time, with the
same fail-closed rule on an unset secret. Deliveries are deduplicated by
GitLab's per-delivery id, and an event is acted on only when its project id
(falling back to its namespaced path for repositories added without the
picker) matches a registered repository.

**Leaving is free.**
Git holds the knowledge. The platform holds a derived index — embeddings,
metadata, run history. Delete a project and nothing you would miss is gone.

### Tests

```bash
pnpm test        # 232 tests
```

The gate and webhook tests run against real Postgres and skip themselves if
none is reachable, so the suite still works on a laptop with nothing running.
Webhook signatures are tested with real HMAC and App JWTs with real RSA keys —
a mocked signer would prove nothing about the only property that matters, which
is that GitHub can verify what we send. GitLab's webhook trust boundary is a
token comparison rather than a signature, and is tested the same honest way:
real constant-time comparisons, not a stubbed-out check.

---

## The CLI

```bash
pnpm cli:build      # → ./bin/specd, run it as ./bin/specd
pnpm cli:install    # → $(go env GOPATH)/bin/specd, and tells you if that is not on PATH
```

`cli:install` uses `go install`, so the binary lands in your Go bin directory.
That directory is often not on `PATH`; the script checks and prints the exact
`export` line if it is missing. Everything below assumes `specd` is runnable —
otherwise substitute `./bin/specd`.

```bash
specd login                  # device flow — confirm in the browser
specd use <project>          # set the default project for this machine
specd projects               # list projects you can see
specd whoami                 # who this machine is signed in as
specd logout                 # forget the stored token

specd spec pull CRM-131      # print an approved spec as markdown
specd spec pull CRM-131 -o spec.md
specd spec status CRM-131    # lifecycle state; exit 3 when unapproved
specd specs list             # every spec and its state
specd specs list --status approved

specd connect .              # register a local repo (code stays on your machine)
specd runner pair XXXXX-XXXXX  # pair this machine as a self-hosted runner
specd open CRM-131           # open the spec in the web app
```

`specd login` needs the **web app running**, because a human confirms the code
at `/cli-login` — a machine cannot mint its own token. The token is stored in
your login keychain on macOS, or `0600` under your config directory elsewhere.

It fetches, registers and reports. It never authors, reviews or approves —
those live in the app, and the server refuses them for CLI tokens regardless of
what this binary asks for.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | fine |
| `1` | something went wrong |
| `2` | usage error |
| `3` | the spec exists but is **not approved** |

Exit `3` is deliberately distinct from `1`, so a pipeline can tell "not stamped
yet" from "something broke":

```yaml
env:
  SPECD_API: https://specd.example.com/api
  SPECD_TOKEN: ${{ secrets.SPECD_TOKEN }}
  SPECD_PROJECT: aurora-crm

steps:
  - name: Require an approved spec
    run: |
      specd spec status "$SPEC_ID"
      case $? in
        0) echo "approved — building" ;;
        3) echo "::error::$SPEC_ID is not approved yet"; exit 1 ;;
        *) echo "::error::could not reach specd"; exit 1 ;;
      esac
```

### Environment

| Variable | Purpose |
| --- | --- |
| `SPECD_API` | API base URL (default `http://localhost:4000/api`) |
| `SPECD_PROJECT` | default project slug, overriding `specd use` |
| `SPECD_TOKEN` | token to use instead of the stored one — for CI |
| `SPECD_WEB` | web app origin; normally learned at login, used by `specd open` |
| `SPECD_RUNNER_TOKEN` | runner token to use instead of the paired one |

## Self-hosted runners

`specd runner pair <code>` pairs a machine to a project — a runner token
lands in its own keychain slot, separate from a signed-in user's own CLI
token, and the command verifies outbound connectivity to the API before
saying so. Generate a pairing code from the project's Settings page.

**This is pairing only.** Nothing yet asks a paired runner to actually do
anything — there is no job queue, no claim/report protocol, and the daemon
that would poll for and execute work does not exist. What's built and what
isn't, and why they shipped separately: [`docs/runners.md`](docs/runners.md),
[`knowledge/decisions/0003-runner-pairing-before-dispatch.md`](knowledge/decisions/0003-runner-pairing-before-dispatch.md).

## The Build station

An approved spec can be handed to the hosted runner (§8 stage 5, mode (a)):

```
POST /projects/:slug/board/specs/:specId/build     # or "▶ Build it" in the spec drawer
```

It implements the tasks in order, one commit each, and leaves a branch for you
to review. Three properties are enforced rather than hoped for:

- **The gate is re-checked at the point of use.** A build is the first moment
  agent output reaches code, so "is this approved?" is asked again — an
  unapproved spec gets the same 409 the CLI gets.
- **The agent gets editing tools only — never a shell.** specd runs the repo's
  own verify command itself, so nothing a model emits becomes a shell command.
- **It never touches your working tree.** Local builds run in a throwaway git
  worktree on `spec/<id>-<slug>`; GitHub and GitLab builds run in a shallow
  clone in a scratch directory. The branch survives, the workspace does not —
  an interrupted build cannot leave you on an unexpected branch.

The as-built spec is written by specd, not the model — it is a verbatim record
of what was approved, and asking a model to reproduce it would invite drift in
the one document meant to be exact.

Builds run for minutes, so the request returns a `runId` immediately and the
work streams to the run log. Verify results distinguish **failed** (your tests
ran and did not pass) from **could not run** (the toolchain or dependencies are
missing) — those mean very different things to a reviewer.

On GitHub or GitLab the branch is pushed and a PR or MR opened, described with
what was approved, by whom, and whether verify actually ran. In local mode the
branch is simply left in your repository. Hosted builds need the Claude Code
CLI either way.

## GitHub

specd talks to GitHub as an **App**, not as a user with a token. An App's
credential mints repository-scoped tokens that expire within the hour and reach
only the repositories someone explicitly granted; a PAT carries its creator's
full authority over everything they can see, forever.

Register it in one click with the API running:

```
open http://localhost:4000/api/github/app/register     # add ?org=your-org for an org
```

It asks for `contents:write`, `pull_requests:write` and `metadata:read`. That is
the whole list — no workflows, no packages, no org administration. **specd never
pushes to your default branch.** Every change an agent makes arrives as a branch
and a PR, and stops there until you merge it.

Full walkthrough, including webhook forwarding for local dev:
[`docs/github-app.md`](docs/github-app.md).

### Merging is adopting

Once the webhook is delivering, the merge *is* the signal — there is no button
to press afterwards:

| What merged | What specd does |
|---|---|
| The setup branch | Records adoption, indexes `knowledge/` |
| A `spec/…` branch | Marks the spec **delivered**, re-indexes so the as-built spec grounds the next one |
| Anything touching `knowledge/` on the default branch | Re-indexes |

Closing a PR without merging is a rejection and changes nothing. That
asymmetry is deliberate: adoption should require the same act as any other
change to your codebase.

The webhook endpoint is unauthenticated by necessity — GitHub has no specd
session — so its signature check is the only thing guarding it. Every delivery
is HMAC-verified over the raw bytes in constant time before the payload is
parsed, deliveries are deduplicated by GitHub's delivery id so a retry cannot
re-run an index, and an event is acted on only if its repository *and*
installation match a registered project. **An unset `GITHUB_WEBHOOK_SECRET`
rejects everything** — it never means "skip the check", so a forgotten variable
cannot become an open write endpoint.

Every delivery is recorded with what specd decided and why, including the ones
it ignored:

```
GET /github/projects/:projectId/deliveries
```

"The webhook arrived and specd chose not to act" and "the webhook never
arrived" are different problems, and this says which one you have.

## GitLab

gitlab.com and self-managed, connected with a personal or project access
token rather than an App — GitLab has nothing App-shaped to install. The rest
of the pipeline does not know the difference: the same `VcsAdapter` interface,
the same branch-and-merge-request write path, the same hosted build station.

Registering a repository's webhook is a per-project API call rather than a
one-time App setup, so it can fail on a token below Maintainer — that failure
degrades the repository to local mode's fallback (the **"I merged it"**
button) instead of blocking the add. Full walkthrough, including the token
scope you need and how to connect a project today (there is no browser flow
yet): [`docs/gitlab.md`](docs/gitlab.md).

## Knowledge and retrieval

`knowledge/` lives in your repos. specd indexes merged docs into pgvector plus a
Postgres full-text index, and retrieves with **Reciprocal Rank Fusion** over
both — RRF needs only each side's ordering, so a weak embedder cannot drag down
a strong lexical match.

The default embedder is a deterministic local hash — no second API key, works
offline, and the lexical half carries relevance. Point
`SPECD_EMBEDDING_PROVIDER=voyage` at a real model and the dense half improves
without a single query changing.

Knowledge **health** is deliberately simple and explainable: staleness, unfilled
stubs and remaining `UNVERIFIED` markers, with the reasons listed. A score
nobody can reason about gets ignored.

---

## What is not built yet

Stated plainly, because the plan phases these and the UI should not imply
otherwise:

- **Jira sync** (P3) — interface-ready, adapter absent.
- **gitlab.com OAuth** — the wizard connects a GitLab project with a pasted
  personal/project access token (validated live) rather than an OAuth button;
  self-managed instances need a token regardless, since an OAuth app would
  have to be registered per instance. A gitlab.com app narrowing this to a
  click is optional wiring on top of the adapter, not built yet.
- **Runner job dispatch** (P2) — `specd runner pair <code>` (above) pairs a
  machine and hands it a credential; nothing yet dispatches work to it. There
  is no job queue, no claim/report protocol, and the daemon that would poll
  for and execute jobs does not exist — subscription mode still only works
  when specd runs on the same machine as Claude Code. See
  `docs/runners.md`.
- **Spend billing** — spend is metered and capped; Stripe is not wired (P3).

---

## Configuration

See `.env.example`. The two that matter in any non-local environment:

- `JWT_SECRET` — session signing.
- `VAULT_MASTER_KEY` — 32 bytes, base64. Wraps every stored credential with
  envelope encryption; ciphertext is bound to its project and kind, so a row
  copied between projects is useless rather than portable.
  Generate with `openssl rand -base64 32`.

Run logs are secret-scrubbed on the way in, not trusted to be clean on the way
out.
