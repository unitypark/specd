# Runbook — local development (unitypark/specd)

Full version, with a troubleshooting table: [README.md § Runbook](../../README.md#runbook).
This copy is the short form for an agent that just needs the commands.

## Prerequisites

Node ≥ 22, pnpm `10.32.1` (pinned via `packageManager`), Docker.

## Run it

```bash
cp .env.example .env
pnpm install
pnpm infra:up && pnpm db:migrate && pnpm db:seed
pnpm dev            # API :4000, web :3000
```

`.env` only needs to exist at the repo root — `apps/api` and `packages/db`
load it themselves before reading anything out of it (`main.ts`,
`migrate.ts`), so nothing needs sourcing into the shell first.

## Verify

```bash
curl http://localhost:4000/api/health
pnpm typecheck && pnpm test
```

## When it breaks

The failure newcomers actually hit: `DATABASE_URL is required — copy
.env.example to .env` means exactly what it says — `.env` doesn't exist yet
at the repo root. Everything else (`EADDRINUSE`, infra unreachable, stale
migrations) is in the README table linked above.
