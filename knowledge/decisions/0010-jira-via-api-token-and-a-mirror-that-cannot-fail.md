# 0010 — Jira via API token, and a mirror that cannot fail the local lifecycle

- **Status:** accepted
- **Date:** 2026-08-10
- **Project:** specd

## Context

The tracker connection has accepted `provider: 'jira'` since P1 and stored a
`Jira <KEY>` label, but nothing read it — the wizard's Jira tile was disabled
with a `P3` badge, honestly. This is that adapter.

The plan (§11) is unusually specific about how to scope it: *"Field mapping UI
is where Jira integrations go to die — keep mapping minimal (status + comment
backlink only) at first."* That constraint drove both decisions here.

## Decision 1 — API token, not 3LO OAuth

Connect with an Atlassian account email plus an **API token**
(id.atlassian.com → Security → API tokens), sent as HTTP Basic. Not the 3LO
OAuth dance.

This is the same trade-off [[0002-gitlab-via-personal-access-token]] made, for
the same reason. 3LO requires registering an Atlassian app with callback URLs
before anyone can connect anything, which puts a developer-portal round trip
between a user and their first spec — and specd's whole pitch is "set this up
in one afternoon." An API token works the moment it is pasted, on any Cloud
site, with no registration by us or by them.

The cost is the same cost GitLab's token carries and is worth naming: the
credential is as broad as the user who created it, lives in the vault for the
life of the connection, and has no per-run minting to shrink it. A 3LO button
narrowing this later is wiring on the same adapter, not a rewrite — every call
goes through one `api()` helper whose only job is attaching auth.

Jira Server/Data Center is still out of scope: different auth, different base
path. Cloud only, and the connect flow says so.

## Decision 2 — The mirror is best-effort, always

**A Jira failure must never fail a specd action.** Approving a spec succeeds
whether or not Jira accepts the transition; the backlink comment is attempted
and its failure is logged to the run/spec, not raised.

This is not defensiveness, it is the correct model of what Jira is here. The
spec lifecycle is specd's own state and the human gate is specd's own
guarantee — §12 calls the approval a security boundary. Making that boundary
depend on a third-party API being reachable would mean an Atlassian incident
could block a team from approving their own work, and worse, that a network
timeout could leave the two systems disagreeing about whether an approval
happened. Local state is authoritative; Jira is a projection of it.

So every mirror call is wrapped, failures are recorded as a warning on the
spec's run log, and the caller never sees them.

## Decision 3 — Status mapping is explicit, and empty by default

No attempt to guess. Jira workflows are per-project and arbitrary: one team's
"Done" is another's "Closed", "Resolved" or "Ready for Release", and the
transition ids behind them are project-specific integers.

The connection stores an optional `statusMap` from specd lifecycle state to
Jira **status name** (not id — names are what a human can read and type, and
the adapter resolves a name to the available transition at call time). An
empty map means no status mirroring at all, which is the default, and the
comment backlink still works. A mapped status that has no available transition
on the issue right now is a logged no-op, not an error — Jira workflows have
guards, and a spec moving to `approved` may simply not be a legal Jira move
from where the issue currently sits.

This is deliberately less than a mapping UI. It is a JSON field on the
connection, which is enough to be useful and cheap to delete if the shape
turns out wrong.

## Consequences

- Comment bodies are **ADF** (Atlassian Document Format), not markdown or
  plain text — Jira Cloud's v3 API rejects a string body. The adapter builds
  a minimal ADF document; nothing else in specd needs to know that.
- Imported issues land as `tickets` with `source = 'jira'`, `externalKey` and
  `externalUrl` set. Those columns already existed from P1, so no migration.
  The ticket's own `key` stays the Jira key, so `spec pull JIRA-142` reads
  naturally.
- **Not verified against a live Jira site.** This was built and tested
  against the documented REST contract with a stubbed transport: request
  shape, auth header, ADF body, pagination, and error handling are covered by
  tests; "Atlassian actually accepts this" is not. The connect flow calls
  `/myself` and reports what came back, so the first real credential proves
  the transport end-to-end at connect time rather than failing later inside a
  spec run. Anything beyond that needs a real site, and the docs say so
  rather than implying coverage that does not exist.
