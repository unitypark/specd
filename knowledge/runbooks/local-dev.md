# Runbook — local development (unitypark/specd)

Getting it running for the first time lives in the
[README's Runbook section](../../README.md#runbook): prerequisites, the six
first-run commands, restarting, the health check, a troubleshooting table and
how to reset. That is the single source for it and this file does not repeat
it — if the two ever disagree, the README is right and this is stale.

What follows is the rest of the loop: the things you need on day two rather
than in the first ten minutes, and the traps that cost someone an hour.

## The shape of a running system

Four processes, and only the first three are usually yours.

| | What | Port | Notes |
| --- | --- | --- | --- |
| Postgres | `docker compose`, pgvector image | `5433` | 5433 on purpose, so it cannot collide with a local 5432 |
| API | NestJS, `pnpm dev:api` | `4000` | `--watch`; restarts itself on save |
| Web | Next.js, `pnpm dev:web` | `3000` | fast refresh |
| Runner | `apps/runner`, started by hand | — | optional; only for subscription-mode agent runs |

`pnpm dev` runs the API and web together. Postgres is independent — leave it
up across sessions.

The runner is a separate daemon that has to be paired first and needs the
`claude` CLI on `PATH`; it exits immediately and says which of the two is
missing. Nothing about the index, the knowledge graph or retrieval needs it —
those all run inside the API (`per knowledge/decisions/0012-index-runs-queued-and-woken-by-listen-notify.md`).

## Verify before a PR

```bash
pnpm typecheck && pnpm test
```

That is the whole gate, and it is what `knowledge/conventions.md` commits to.
There is no lint step; the compiler and the tests are it. CI runs the same two
commands on every push and pull request, so a green local run should mean a
green CI run — with one deliberate difference, below.

### The trap: green does not always mean run

Every test that needs Postgres skips itself when none is reachable, so the
suite stays green on a machine with no infra. That is deliberate and it is
also the easiest way to fool yourself — the summary reads
`Tests 23 skipped (23)` while looking, at a glance, like a pass.

Two things follow. Bring Postgres up before trusting a green run on anything
touching the index, the graph, retrieval, runs or webhooks. And when a whole
integration file reports as *skipped* rather than failing, suspect the
suite's own setup rather than the database: a `beforeAll` that throws — a
fake missing a method a real adapter grew, say — surfaces the same way.

CI refuses to accept either. It runs the suite a second time with a JSON
reporter and fails if anything was skipped, which is the one place it is
deliberately stricter than a local run.

## Evals

```bash
DATABASE_URL="postgres://specd:specd@localhost:5433/specd" pnpm eval
```

Evals grade quality; tests assert behaviour. They are not in `pnpm test` and
must not become a gate — see [evals/README.md](../../evals/README.md) for why,
and for what the numbers do and do not mean.

`DATABASE_URL` has to be explicit here. The API and the migration runner load
the repo-root `.env` themselves; the eval runner does not, so it fails with
`DATABASE_URL is required` if you forget. The retrieval eval creates a scratch
project, indexes into it and deletes it again — it does not touch your data,
but it does write to your database.

## Writing a migration

Plain SQL in `packages/db/migrations/`, applied in filename order, each in its
own transaction, tracked in `_specd_migrations`. Authored rather than
generated, because the schema uses pgvector types, generated `tsvector`
columns and partial indexes that a schema-diff tool cannot express.

```bash
pnpm db:migrate     # idempotent; applies only what is new
```

Two things worth knowing before you write one:

- **A generated column cannot be altered in place.** Changing its expression
  means dropping and re-adding the column, which rewrites the table and
  rebuilds its indexes. Cheap at knowledge-base scale, worth saying out loud
  in the migration for anyone running it against a large one — `0015` is the
  worked example.
- **Update the Drizzle schema in the same change.** `packages/db/src/schema.ts`
  is not generated from the SQL and nothing checks the two agree; they drift
  silently and the type error appears somewhere unrelated later.

## Working on the knowledge index

Re-indexing is queued, not immediate. The knowledge tab's re-index button
returns a run id and follows the run's log over SSE, so watch the log rather
than the doc list to know what happened
(`per knowledge/decisions/0012-index-runs-queued-and-woken-by-listen-notify.md`).

Useful to know while iterating:

- A doc whose content sha *and* index fingerprint are unchanged is skipped
  entirely. Changing the chunker or the embedder changes the fingerprint, so
  those re-index everything without you doing anything; editing extraction
  rules alone does not, which is what `LINKS_VERSION` is for.
- Coupling, drift and symbol extraction run per index run and cost a git walk
  or a read per changed file. On a local repo that is instant; on a hosted one
  it is HTTP.
- The graph, health counts and retrieval all derive from the index. If a
  number looks wrong, re-index first — the derived state is disposable, and
  the guards are designed to refuse a run rather than half-apply one.

## Resetting

The README covers wiping the database. Two other bits of state are easy to
forget because nothing tells you they exist:

- `.specd-work/` at the repo root — scratch checkouts from local-mode runs.
  Safe to delete when it gets confusing.
- `apps/web/.next` — see the README's troubleshooting row about running
  `pnpm build` while a dev server is live. `rm -rf apps/web/.next` fixes it.
