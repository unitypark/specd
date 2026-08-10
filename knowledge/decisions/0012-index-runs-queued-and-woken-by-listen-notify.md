# 0012 — Index runs are queued rows woken by LISTEN/NOTIFY

- **Status:** accepted
- **Date:** 2026-08-10
- **Project:** specd

## Context

Re-indexing ran *inside* the webhook request. `GitHubWebhookService.reindex`
awaited `PipelineService.reindex`, which listed `knowledge/`, read every file,
chunked, embedded and wrote — all before the handler returned 200. GitHub
gives a delivery about ten seconds before it times out and retries. On a
hosted repo the listing alone is a full recursive tree call and each file is
its own GET, so a knowledge base of any size can spend that budget before the
first embedding.

The failure is quiet in the worst way: GitHub records a failed delivery and
retries, the retry re-enters an index run that may still be in flight, and the
merge that triggered it looks indexed when it is not.

S-101 already built lease-and-reclaim for dispatched jobs, and the natural
reflex was to reuse it — queue index runs to the runner fleet. That is wrong.
The runner's contract is explicit (`apps/runner/src/main.ts`): it "never
touches the database or the knowledge index directly", and only ever sees an
opaque prompt and returns parsed JSON. Indexing is database and VCS work, and
both live in the API. Moving it to the runner would mean shipping the DB
credentials and the VCS adapters to every paired laptop.

So the work stays in the API process. The question is only how it leaves the
request path, and how the API learns there is work to do.

WebSockets were considered and rejected. A socket is a transport between a
server and a *connected client*; it makes nothing durable, prevents no
duplicate run, and is not needed at all to hand work to your own process.
Anything handed to a separate process still needs a row to survive a crash —
at which point the socket only saves polling latency rather than replacing the
mechanism. specd also already streams realtime over SSE (`@Sse` at
`apps/api/src/runs/runs.controller.ts`), and every realtime need here is
one-directional server→client, which is exactly SSE's shape. A second
transport would earn its keep only if the browser needed to stream *to* the
server, and nothing does.

Plain polling would work — it is what runner dispatch does, and
[[0008-remove-unused-queue]] is emphatic that a `queued` row is not a queue.
But a poll interval is a latency floor on every merge, and the interval that
makes merges feel instant is the interval that wakes the database all day for
nothing.

## Decision

An index run is an `agent_runs` row inserted with status `queued`. The
webhook's job ends there, so it returns in the time it takes to write one row.
A worker inside the API process claims the row and does the work.

The worker is woken by Postgres `LISTEN`/`NOTIFY` on a `specd_index_queued`
channel, not by polling. Three properties make this the right fit rather than
merely a clever one:

1. **It adds no dependency.** `LISTEN`/`NOTIFY` is Postgres, which
   [[0008-remove-unused-queue]] left as the only runtime service. A message
   broker would put back exactly what that decision removed.
2. **It is transactional.** Postgres delivers a `NOTIFY` only if its
   transaction commits, so the wake-up can never arrive before the row it
   refers to is visible. That is the classic race in queue-by-table designs
   and here it is impossible by construction.
3. **The row, not the message, is the source of truth.** `NOTIFY` is
   best-effort and delivers nothing to a disconnected listener. So the design
   never depends on receiving one: the notification only decides *when* the
   worker looks, never *whether* the work happens.

Because of (3) the worker also drains on startup and on a slow safety tick
(60s, versus 5s for runner polling). The tick is a backstop for a dropped
listen connection or a notification issued while reconnecting, not the primary
path. If notifications stopped entirely, indexing would degrade to
once-a-minute rather than stop.

Claiming reuses the pattern from [[0004-runner-job-dispatch]] — `UPDATE …
FROM (SELECT … FOR UPDATE SKIP LOCKED)` — so two API instances listening on
the same channel cannot claim the same row, and a `LISTEN`-based fan-out to
several instances is safe by default rather than by luck.

Crash recovery mirrors S-101: an index run left `running` past a lease is
reclaimed by the next drain. The lease is generous (15 min) because an index
run is one long database transaction, not a heartbeat-able job.

Bursts coalesce. Merging three PRs in a minute should index once, not three
times, so enqueueing folds into an existing `queued` run for the same project
and takes the union of the repositories to index. The work is idempotent
either way; this just stops paying for it repeatedly.

## Consequences

- A webhook handler no longer waits for an index. Delivery latency becomes one
  insert, and GitHub's timeout stops being a factor in how large a knowledge
  base can be.
- `POST /projects/:slug/reindex` now returns `{ runId, status: 'queued' }`
  instead of counts. Callers that want the outcome follow the run — the web
  app streams it over the SSE the run log already exposes, so the re-index
  button reports what actually happened instead of returning before it starts.
- Index runs appear in the runs list as `queued` before they are `running`.
  That is new for this kind and is the honest state.
- The runner's claim query now filters to dispatchable kinds. It previously
  keyed only on `job_payload IS NOT NULL`, which would have let a paired
  runner claim an index run the moment index runs carried a payload — and then
  fail it, since `report()` has no finisher for the kind. Latent before this
  change; load-bearing now.
- ~~Multi-instance API deployments work for claiming, but the run-log SSE bus
  is still a per-process `EventEmitter`.~~ Fixed 2026-08-10 with this same
  mechanism; see the update below.


## Update — 2026-08-10: the run-log bus

Run-log streaming used the per-process `EventEmitter` this decision flagged, so
a viewer attached to one API instance saw nothing from a run executing on
another — silently, and only once somebody ran more than one instance, which is
the worst moment to find out.

It now announces on a `specd_run_log` channel, with the same contract the index
queue uses: **the payload is the run id and whether it ended, never the line
itself.** A viewer re-reads `run_logs` from its own last sequence, so the table
stays the truth, a `NOTIFY` payload can never be too large for a long log line,
and a notification only decides when to look.

Three things fell out of reading by sequence rather than pushing lines:

- **Replay and follow became one mechanism.** The controller used to fetch the
  history, then subscribe. A line written between those two steps reached
  nobody. Now a subscription simply pulls forward from sequence zero.
- **Duplicate delivery became impossible.** The local emitter is kept as a fast
  path so a single instance still streams if `LISTEN` cannot start, and both
  paths poke the same read — which has nothing left to deliver twice.
- **A concurrency bug surfaced in test.** A poke arriving while a read was in
  flight was dropped unless it also said the run had ended, which is to say
  most pokes for a run still in progress: exactly the lines a viewer is
  watching for. The two-instance test found it before anyone deployed two
  instances.
