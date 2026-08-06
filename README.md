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
The write path is a branch plus a pull request on hosted providers, or a branch
you diff in local mode. Nothing writes to a default branch.

**Leaving is free.**
Git holds the knowledge. The platform holds a derived index — embeddings,
metadata, run history. Delete a project and nothing you would miss is gone.

### Tests

```bash
pnpm test        # 97 tests
```

The gate tests run against real Postgres and skip themselves if none is
reachable, so the suite still works on a laptop with nothing running.

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

- **GitHub** — the adapter is written against the same interface as local mode
  and opens real PRs, but needs a GitHub App registration and token. The wizard
  says so rather than pretending.
- **GitLab** (P2), **Jira sync** (P3) — interface-ready, adapters absent.
- **Hosted build runners** (P2) — the Build station currently hands off via
  `specd spec pull` or a human. Handoff modes (b) and (c) of §8 stage 5.
- **Remote runner pairing** (P2) — subscription mode works when specd runs on
  the same machine as Claude Code (above). Pairing a *separate* runner over the
  network, so a hosted specd can dispatch to your infrastructure, is not built.
- **Webhooks** — merge detection is manual (`I merged it` / `specd` re-index)
  rather than webhook-driven.
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
