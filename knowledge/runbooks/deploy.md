# Runbook — deploy (unitypark/specd)

> **Nothing deploys specd today.** There is no Dockerfile for the app, no CI
> workflow, no hosting configuration and no environment beyond a laptop. That
> is a statement about the repository as it stands, not a gap in this
> document — verified by absence: `docker-compose.yml` provisions Postgres
> only, and there is no `.github/workflows/`.

So this is not "how we deploy". It is what someone standing up the first
environment has to decide and what the code already requires of them, with the
unknowns named as unknowns. Fill it in as those decisions get made; the
UNVERIFIED markers are the todo list.

## What the code already requires

None of this is a choice — it falls out of what is in the repository.

**Runtime.** Node ≥ 22 and pnpm 10.32.1 (pinned via `packageManager`).
Postgres with the `vector` extension available; local uses
`pgvector/pgvector:pg17`. Postgres is the only runtime dependency the platform
has, and [[0008-remove-unused-queue]] is the decision that keeps it that way —
adding a broker back is a decision to relitigate deliberately, not a deploy
detail.

**Build and start.** `pnpm build` compiles packages, then the API, then the
web app, in that order. The API then starts as `node dist/main.js` and the
web app as `next start`. Both are plain long-running Node processes.

**Migrations run from zero.** `pnpm db:migrate` applies every migration in
filename order, each in its own transaction, tracked in `_specd_migrations`;
a second run applies nothing. The zero-to-current path is exercised by a test
against a throwaway database, which is the path a first deployment takes and
the one that never happens locally.

**The runner is not server-side.** It runs on a developer's own machine, needs
the `claude` CLI signed in there, and reaches the API over HTTP. A deployment
hosts the API, the web app and Postgres — nothing else.

## The five things that will bite

1. **`VAULT_MASTER_KEY` is not rotatable and not recoverable.** It decrypts
   every stored VCS and tracker credential. Lose it and every connected
   project must be reconnected by hand; leak it and every stored token is
   compromised. 32 bytes, base64 (`openssl rand -base64 32`). It belongs in a
   secret store, not in an image or a `.env` baked into a build.
2. **`NEXT_PUBLIC_API` is baked at build time**, not read at boot. Building the
   web app with the default and deploying it anywhere else produces a UI that
   silently talks to `http://localhost:4000/api` from the user's browser. It
   has to be set for the build, not just for the process.
3. **Webhooks need a publicly reachable `API_PUBLIC_URL`**, and an unset
   webhook secret rejects every delivery rather than skipping the check — so a
   half-configured install looks connected and silently acts on nothing. See
   [docs/github-app.md](../../docs/github-app.md) and
   [docs/gitlab.md](../../docs/gitlab.md).
4. **`JWT_SECRET` changing logs everyone out.** Fine, as long as it is not
   regenerated per deploy or per replica.
5. **`ANTHROPIC_API_KEY` is optional and its absence is loud.** Without a
   platform key the app runs and agent runs fail with a clear error, per
   project, until that project supplies its own.

## Running more than one instance

This works, and it is worth knowing exactly how far it has been thought
through, because "it runs" and "it is safe to scale" are different claims.

**Safe.** Two API instances cannot run the same index job: claiming is
`FOR UPDATE SKIP LOCKED` and the worker is woken by Postgres `LISTEN/NOTIFY`
(`per knowledge/decisions/0012-index-runs-queued-and-woken-by-listen-notify.md`).
Run-log streaming crosses instances over the same channel, so a viewer
attached to one instance sees a run executing on another.

**Deliberate.** `SPECD_INDEX_WORKER_ENABLED=false` lets an instance serve
requests without executing index runs — a way to keep indexing off the
instances taking user traffic.

**Tested, 2026-08-10.** Two API processes against one Postgres, six index runs
queued at once: every run succeeded, each executed exactly once, no duplicate
rows. Running it found three bugs that reading the code had not, all now
fixed — a listing that asked git for an empty pathspec, two concurrent runs on
one repository colliding on the unique index, and a query inside the index
transaction that reached for a second pool connection and deadlocked when
there were none spare. An index run now takes a transaction-scoped advisory
lock on its repository, so concurrent runs serialise instead of racing.

Still unproven at a level a production deployment would want: this was one
machine, two processes, no load, no restarts mid-run, no network partition
between an instance and Postgres.

## Backups

Two different things live in Postgres and only one of them is precious.

- **Derived and disposable:** the knowledge index — chunks, embeddings, links,
  code nodes, coupling, health. All of it is rebuilt from git by re-indexing,
  because git is the source of truth and the index never outlives it
  ([[0001-adopt-spec-driven]]).
- **Precious:** everything else. Projects, specs and their approval stamps,
  runs and their logs, encrypted credentials. One caveat with a clock on it:
  webhook delivery records are the audit trail for "why did specd act", and
  they are pruned after `SPECD_WEBHOOK_RETENTION_DAYS` (default 30) — a backup
  older than the window is the only place a pruned delivery still exists. Specs are append-only and carry
  the audit trail of who approved what; losing them loses the record the whole
  product exists to keep.

A `pg_dump` of the database plus the `VAULT_MASTER_KEY` held separately is
sufficient to restore. Neither is sufficient alone: the dump without the key
leaves every credential unreadable.

UNVERIFIED — no backup schedule, retention or restore drill exists. A restore
has never been performed.

## Not decided yet

Each of these is a real gap, not an oversight in the writing:

- **UNVERIFIED — no host.** No platform chosen, no container image, no process
  supervision, no reverse proxy or TLS termination. This is the decision every
  other unknown here is waiting on, and it is not a technical one.
- **CI exists; CD does not.** `.github/workflows/ci.yml` runs
  `pnpm typecheck && pnpm test` on every push and pull request, against a real
  pgvector service — and then fails the run if the tests that need Postgres
  were skipped rather than passed, because vitest exits zero either way.
  Nothing publishes an artefact, and nothing deploys.
- **UNVERIFIED — no observability.** The API logs to stdout and exposes
  `GET /api/health`, which reports database reachability, whether an AI key is
  configured, and which embedder is active — verified against two running
  instances. There is no metrics endpoint, no log aggregation and no alerting,
  and `/api/health` is a liveness check that says nothing about whether index
  runs are being picked up.
- **UNVERIFIED — no migration rollback story.** Migrations only roll forward.
  A bad one is recovered by writing the next one, or from backup.
- **UNVERIFIED — no zero-downtime story.** Migration-then-restart against a
  single instance means a visible restart.

## The day the repository goes public

Run `./scripts/protect-main.sh`. GitHub's free plan refuses branch rulesets
on private repositories, so protection for `main` is staged as that script
rather than configured: one command, applied the moment the flip happens.
It enforces PR-only changes with the `verify` check required before merge —
closing the gap that let a merge land while its CI was still running — plus
no force pushes and no branch deletion. The `grade` job is deliberately not
in the required checks; see the workflow header for why.

## Rolling back

Write this section first, when there is something to roll back. Today the
honest answer is that a deployment is a process you started by hand, and
rolling it back is checking out the previous commit, rebuilding and
restarting — with the caveat above that the schema does not roll back with it.
