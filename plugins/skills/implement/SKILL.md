---
name: implement
description: Work through an approved specd spec's tasks in order — one commit per task, verify between tasks, knowledge updated in the same change. Use after /specd:pull, or when the user says "implement the spec", "do the next task", or "continue the build".
---

# /specd:implement

Implement a pulled spec, task by task, in order. The discipline this skill enforces is the repo's own: **tasks in order, one commit each, docs riding the change, verify before the PR.**

## Before the first task

Confirm you have the spec (`.specd-work/<id>.md` from `/specd:pull`) and that you are on its `spec/<ID>-<slug>` branch. If the spec was never pulled, run `/specd:pull` first — implementing from the ticket text instead of the approved spec defeats the entire gate.

Re-check the gate if any time has passed: `specd spec status <id>`. A spec can be revised while you work, and exit 3 means the version you hold is no longer the one that is approved.

## The task loop

For each task, in the order the spec lists them:

1. **Read before writing.** If the task touches an area whose knowledge document you have not read yet, read it now. `knowledge/conventions.md` governs how code here is written — lint rules, layout, test patterns.
2. **Implement the task and nothing else.** Tasks are sized `S`/`M`/`L` and scoped deliberately. Work that belongs to a later task belongs in a later commit; work in no task at all is scope you should surface rather than absorb.
3. **Write the tests the task implies.** Match the existing test style rather than importing a new one — read a neighbouring test file first.
4. **Update `knowledge/` in the same commit** when the task changed something a document describes. This is rule 3, and it is not a courtesy: *docs ride the change; they never trail it.* A behaviour change with a stale document is an incomplete task, not a finished one with a follow-up.
5. **Run the verify command** — the repo's `AGENTS.md` names it under "Verify before PR". Run it between tasks, not only at the end, so a failure names the task that caused it.
6. **Commit.** One task, one commit. Write the message as a sentence about what changed and why, matching the repo's history — read `git log` if the house voice is unclear. Reference the spec id.

Report progress as you go: which task you finished, what the verify command said. If a task cannot be done as written, stop and explain rather than improvising around it — a spec that does not survive contact with the code is a finding worth a human's attention, and it becomes a **Deviation** in the as-built record.

## What the design claims mean while you work

A Design claim citing a knowledge file is a constraint you implement against. If the cited document turns out to be wrong about the code, you have found drift: fix the document in this PR and say so in the PR description. If the claim is marked `UNVERIFIED`, it was never grounded — treat it as an open question, implement the most defensible reading, and record what you chose.

## Finishing

When the last implementation task is done:

1. Run the full verify command one more time, clean.
2. Run `/specd:as-built` — the final task of every spec is its as-built record, and it is not optional.
3. Open the PR. The title carries the spec id. The description cites the knowledge files you relied on (`per knowledge/architecture.md#auth`) — that is rule 2, and it is what makes the next reader's job possible.

Never push to a default branch. Never mark a task done because it is nearly done — a failing verify is a failing task, and reporting it honestly is worth more than a green summary.
