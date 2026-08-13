---
name: as-built
description: File the as-built record for a spec you implemented by hand into knowledge/specs/, assembled from the approved spec rather than written from memory, with a Deviations section where reality diverged. Use as the final task of a spec, or when the user asks to "file the as-built" or "close out the spec".
---

# /specd:as-built

The final task of every spec is its as-built record. This skill is for the **manual path** — a spec you pulled and implemented yourself in this editor.

> If specd's own build station ran this spec, the record already exists: specd wrote it with `renderAsBuiltMarkdown()` at build time, and the same function runs on a paired runner so both produce identical bytes. Check `knowledge/specs/` before doing anything here. Two records for one spec is worse than none.

## The rule that shapes this skill

**You do not write the body of this file from memory.** `packages/shared/src/spec.ts` says why, and it is the house position: the as-built record is a verbatim record of what a human approved, so asking a model to reproduce it invites drift in the one document that has to be exact.

So the body is **copied**, not composed. Your judgement goes in exactly one place: the Deviations section.

## Assemble the file

**Path** — `knowledge/specs/<TICKET-KEY>-<slug>.md`, ticket key **uppercased**. (The branch uses the same key lowercased; that asymmetry is deliberate, so match each exactly.) In a multi-repo project this lands in the **primary** repo — the repo's own `AGENTS.md` rule 7 names which one.

**Body** — re-pull the approved spec so the bytes come from the server, not from your context:

```bash
specd spec pull <id>
```

**Header** — these three comment lines go above the pulled markdown, verbatim:

```markdown
<!-- Filed automatically by specd when <TICKET-KEY> was built. -->
<!-- This is a historical record: never rewrite it. If reality later -->
<!-- diverged, append a "## Deviations" section below.              -->
```

**Verification** — append a section reporting what the verify command actually did. Three outcomes, three different truths, and collapsing them makes the record claim something nobody checked:

```markdown
## Verification

`<verify command>` — passed
```

Use `passed`, `**failed** at build time`, or `not run`. If the repo has no verify command, the section reads `No verify command was detected for this repository.` Run the command before you write this. Reporting `passed` because it passed earlier, or because it probably would, is the one lie this record cannot survive.

## Write the Deviations section

Append `## Deviations` only if reality diverged from the approved spec. This is the part that is yours to write, and it is the reason the record is worth filing.

A deviation is worth recording when someone reading this spec later would otherwise be misled:

- a task implemented differently than designed, and why
- a design claim that turned out to be wrong about the code
- something the spec required that was not built, and what happened instead
- an `UNVERIFIED` claim you had to settle, and how you settled it

Write it as prose that survives without the conversation that produced it — name the task, what the spec said, what you did, and the reason. "Task 3: the spec designed this against the webhook path; the webhook cannot see merge commits on forks, so it runs on the merge poll instead."

If nothing diverged, omit the section. An empty Deviations heading reads like a question nobody answered.

## Never

- **Never rewrite an existing as-built record.** `knowledge/specs/` is append-only by policy. If reality has moved since it was filed, append to its Deviations section — do not edit the body, the header, or the verification line.
- **Never paraphrase the approved spec.** If the pulled markdown and your memory of the spec disagree, the pulled markdown is right.
- **Never file the record before the work is verified.** The record exists to say what was actually built.

Commit this in the same PR as the implementation. Then the spec is done.
