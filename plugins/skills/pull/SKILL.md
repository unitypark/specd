---
name: pull
description: Start work on an approved specd spec — check the gate, fetch the spec, read the knowledge the design cites, and open the spec branch. Use when the user names a spec id or ticket key ("build CRM-1", "pull S-104", "start on the runner spec"), or asks what is ready to build.
---

# /specd:pull

Begin a spec. The order matters: **the gate first, the knowledge second, the branch third.** Nothing here writes code — this skill ends with you ready to implement and the user knowing what you read.

## 1. Check the gate before anything else

```bash
specd spec status <id> --json
```

Exit codes are the contract, not the text:

| Exit | Meaning | What you do |
| --- | --- | --- |
| `0` | approved and buildable | continue to step 2 |
| `3` | the spec exists but is not approved | **stop** |
| `1` | not logged in, no project set, server unreachable | report the message verbatim and stop |
| `2` | usage error | fix the invocation |

On exit 3, stop and say so plainly — name the state the spec is in and point at the review, e.g. "S-104 is in `in_review`; it needs a human approval before it can be built. `specd open S-104` opens it." Do not offer to implement it anyway, and do not start a branch. A human approving a spec is the one step in specd that software is not allowed to do for them; working ahead of it produces code no one agreed to.

If the id is unknown, `specd specs list` shows what exists and its state.

## 2. Fetch the spec

```bash
specd spec pull <id> -o .specd-work/<id>.md
```

`-o` writes the file and reports to stderr; without it the markdown goes to stdout. Keep the file — the as-built step needs it to diff intent against reality. `.specd-work/` is already gitignored in repos specd has grounded; if it is not, write to a path the user picks rather than adding one.

Read the whole spec before acting. It has three parts, and each has a job:

- **Requirements** — user stories with EARS acceptance criteria (`WHEN/WHILE/IF/WHERE <trigger> THE SYSTEM SHALL <response>`). These are what "done" means. One criterion, one behaviour.
- **Design** — claims, each either citing a knowledge file or marked `UNVERIFIED`. The citations are your reading list. The `UNVERIFIED` markers are the review agenda, not decisions you may quietly settle.
- **Tasks** — ordered, sized `S`/`M`/`L`, sometimes carrying a `repo` for multi-repo projects. The final task is always the as-built record.

## 3. Read what the design cited

This is rule 1 of the repo's `AGENTS.md`, and it is the whole reason the spec is worth having: **do not re-derive what is already written down.**

Read `knowledge/README.md` first — it maps documents to tasks. Then read every file the Design claims cite. A claim citing `knowledge/architecture.md#auth` means the auth section of that document is load-bearing for your implementation; read it, and if the code contradicts it, that contradiction is the finding you report.

Where the specd MCP server is configured, `search_knowledge` answers this faster and returns the citations and code excerpts already resolved. Prefer it to grepping the repo blind.

## 4. Open the branch

```bash
git switch -c spec/<id>-<slug>
```

The `spec/<id>-<slug>` shape is rule 6 and it is load-bearing in three places: specd's webhook matches merged branches back to the spec, the gate hook in this plugin reads the id out of the branch name, and the PR title carries the id for the humans. `<slug>` is the spec title, lowercased and hyphenated.

If the working tree is dirty, say so and let the user decide — do not stash or discard.

## 5. Report before you build

Tell the user, briefly:

- what the spec asks for, in one or two sentences
- the task list with sizes, in order
- which knowledge files you read
- any `UNVERIFIED` claim or open question, because those are the parts most likely to be wrong

Then stop. `/specd:implement` does the work.
