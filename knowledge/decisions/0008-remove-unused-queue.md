# 0008 — Remove the provisioned-but-unused queue (BullMQ + Redis)

- **Status:** accepted
- **Date:** 2026-08-10
- **Project:** specd

## Context

`bullmq` and `ioredis` were dependencies of `apps/api`, a `redis:7-alpine`
service ran in `docker-compose.yml` with its own named volume, `REDIS_URL`
sat in `.env.example`, `Config` exposed `redisUrl`, and the README's stack
line advertised "Redis/BullMQ".

Nothing imported any of it. `PipelineService`'s own doc comment pointed at
"the BullMQ worker in `queue/`" — a directory that has never existed. The
plan's §9 sketch named a queue, and the dependencies were added in
anticipation of it; the code then went a different way and nobody swept up.

Three separate readers had already caught this without the loop being
closed:

- [[0003-runner-pairing-before-dispatch]] noted the queue was "provisioned in
  docker-compose but unused" and that no `queue/` directory existed.
- The onboarding agent's own scan wrote it into `knowledge/architecture.md`
  as an `UNVERIFIED` marker: "confirm BullMQ is actually wired in `apps/api`
  and which queues exist." It was right to doubt it, and the marker sat
  unresolved.
- The rev-28 plan reconciliation raised it as decision D14.

The cost of leaving it: every reader has to discover independently that the
queue is fiction, `pnpm infra:up` starts a container nobody uses, and the
README's stack line — the first technical claim a visitor reads — is false.

## Decision

Delete all of it: both dependencies, the compose service and its volume,
`REDIS_URL` from `.env.example`, `Config.redisUrl`, and the stack-line claim.
Rewrote the `PipelineService` comment to describe what actually happens.

Runner dispatch is *not* a queue and does not need one. A runner claims a
`queued` row from `agent_runs` by polling (`POST /runners/jobs/claim`,
atomic per [[0004-runner-job-dispatch]]); Postgres is the only store
involved, which is the right size for a fleet that is one machine per
project in practice.

A real queue becomes warranted when runs execute somewhere other than the
API process and need scheduling across workers — hosted ephemeral containers
(plan D1). At that point it should be chosen against the requirements that
actually exist then, not inherited from a guess made before the code did.
Git remembers the version that had it.

## Consequences

- `pnpm infra:up` starts one container. The reset instructions, the
  troubleshooting table and the architecture doc drop their Redis rows.
- One less credential-bearing service in the dev setup, and one less thing
  a self-hoster has to run.
- Reintroducing a queue means a new dependency and a new ADR — deliberately.
  The `prepare()`/`finalize()` split that dispatch already uses is the seam
  it would plug into, so nothing here forecloses it.
- The `UNVERIFIED` marker in `knowledge/architecture.md` is resolved by
  making the claim false-then-deleted rather than by verifying it — worth
  noting as the convention working as intended: the marker outlived three
  chances to be checked, and flagging it is what eventually got it fixed.
