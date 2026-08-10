# 0011 — specd develops specd, from here forward

- **Status:** accepted
- **Date:** 2026-08-10
- **Project:** specd

## Context

`AGENTS.md` rules 5–7 say work arrives as approved specs, that one task is at
most one PR, and that every spec ends by filing itself into
`knowledge/specs/`. The repository has not followed them.

At the rev-28 reconciliation, 44 of 45 commits had shipped with no spec at
all; only [[S-104]] ever ran the loop end to end. Five more PRs shipped during
the rev-28 work itself — the truth pass, build dispatch, the test floor, the
Jira adapter, the template gallery — and none of those ran it either. That is
six substantial changes to the product whose entire purpose is gating
substantial changes.

The excuse was real and is now spent. For most of that history the loop did
not exist: there was no board to file a ticket on, no `SpecAgent` to draft
against, no gate to pass. By the end of the rev-28 work all of it existed and
had been exercised end to end by `e2e-loop.ts`, against a fixture. The only
thing left untested was the case that matters most — the loop run against a
real, messy, non-fixture repository, by people who would notice if the output
were poor.

## Decision

**From rev 28 forward, changes to specd enter as specd tickets and leave as
approved specs with their as-built file.** The pre-loop history stands as it
is; nothing is retro-specced, because an as-built record written months after
the fact is fiction, and `knowledge/specs/` is supposed to be evidence.

The first item under the new rule is **S-101 — "Reclaim jobs abandoned by a
dead runner"**, drafted by specd against this repository on 2026-08-10 and
awaiting a human's approval at the time of writing.

## What the first real run showed

Worth recording, because it is the only evidence that any of this works
outside a fixture.

**The knowledge base grounded it.** Retrieval ran over 18 indexed documents
from this repo. Ten of the spec's thirteen design claims carried citations,
and every one pointed at a decision record written during the rev-28 work —
0003, 0004, 0009. The compounding-context claim in §1 is not a slogan here;
the spec is legible as a consequence of the documents that preceded it.

**It found something a human had missed.** Nobody had noticed that reclaiming
a *build* is not equivalently idempotent to reclaiming a spec draft: the
runner's filesystem is the state carried between model calls, and partial work
may already be pushed to the remote under the dead runner's own git
credentials. It then drew the consequence — that specd cannot clean up that
branch, because [[0009-build-dispatch-runner-git-credentials]] deliberately
leaves it holding no credential — and flagged the ownership question as
needing a decision rather than inventing one. That is the loop paying for
itself on its first real use.

**It refused to invent what it could not ground.** Three claims came back
`UNVERIFIED` rather than confident: the concrete lease durations, the reclaim
cap and its UX, and whether new columns are needed at all. Those are exactly
the three things a model would have been happy to make up.

**The gate held against the agent that wrote the spec.** Pulling S-101 while
it was still `draft` was refused server-side with a 409 — *"a named human has
to stamp it first. That is the whole point of the gate."* An agent produced
the spec and an agent could not consume it. This decision is written by an
agent that cannot approve it either.

## Consequences

- Branches carry the spec id (`spec/<id>-<slug>`), PR titles reference it, and
  the final task of every spec files the as-built record. That is rules 5–7,
  now actually in force.
- A change too small to deserve a spec does not get one — the rule is for
  work, not for typo fixes. Judgement about which is which stays with the
  person opening the PR, and the honest signal that the line has moved too far
  is `knowledge/specs/` growing thin again.
- specd's own board becomes the backlog of record for the open items the plan
  tracks: the runner docker image, concurrency and job leases, Jira inbound
  sync, gitlab.com OAuth, Stripe.
- The loop's weakest point is now visible and was not before: drafting a spec
  needs a model, and this project runs it through a locally logged-in Claude
  Code (D2). A contributor without one can read and approve specs but cannot
  draft them. That is a real barrier to outside contribution and is not solved
  here.
