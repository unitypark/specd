# The specd plugin for Claude Code

`AGENTS.md` tells an agent to work from an approved spec, read `knowledge/`
before writing code, and update the docs in the same change. It is a good file.
It is also, on its own, enforced entirely by hope — nothing stops an agent from
implementing a draft nobody approved, and nothing notices when a branch ships
code with a stale document beside it.

This plugin makes three of those rules executable.

## Install

```
/plugin marketplace add unitypark/specd
/plugin install specd@specd
```

The repository is its own marketplace (`.claude-plugin/marketplace.json`), so
there is nothing to publish and nothing to trust beyond the repo you already
have. It needs the `specd` CLI on your `PATH` (`pnpm cli:install`) and a
machine that has run `specd login`.

## What you get

### Skills

| Command | What it does |
| --- | --- |
| `/specd:pull <id>` | Checks the gate, fetches the approved spec, reads the knowledge its design cites, opens the `spec/<ID>-<slug>` branch |
| `/specd:implement` | Works the task list in order — one commit per task, verify between tasks, `knowledge/` updated in the same change |
| `/specd:as-built` | Files the as-built record into `knowledge/specs/`, assembled from the approved spec rather than written from memory |

The skills carry the reasoning, not just the commands: why the gate is checked
before the branch is made, why the as-built body is copied rather than composed,
what counts as a deviation worth recording.

### Hooks

**`gate.sh`** — `PreToolUse` on `Write`/`Edit`. On a `spec/<ID>-<slug>` branch it
asks `specd spec status <id>`, and blocks the edit when that returns exit 3: the
spec exists and no human has approved it. Two disciplines make it liveable:

- **Fail open on infrastructure.** No `specd` on the PATH, not logged in, no
  project set, server unreachable, not a git repo, not a spec branch — the hook
  stays out of the way. A hook that blocks every edit when the API is down is a
  hook people uninstall.
- **Fail closed on a verdict.** Exit 3 is the server positively saying this spec
  is not approved. That is the only case it blocks.

The approved verdict is cached for a minute so `Write` and `Edit` don't each pay
an HTTP round trip; the *blocked* verdict is never cached, so approving a spec
unblocks the next edit immediately.

**`docs-ride-the-change.sh`** — `Stop`. When a spec branch changed code and
nothing under `knowledge/`, it asks once whether a document went stale. Claude
Code sets `stop_hook_active` on the retry, so a considered "nothing to document"
ends the turn normally. This is a prompt, not a gate — conflating the two would
teach people to disable both.

## What it deliberately does not do

- **It cannot approve anything.** Approval is a signed-in human in the web app,
  enforced in the service layer, by a database constraint, and by the board UI.
  A plugin that could open the gate would defeat the product.
- **It does not re-implement the CLI.** Every skill shells out to `specd`, so
  there is one contract to keep and the exit codes stay the source of truth.
- **It does not write the as-built record from memory.** That file is a verbatim
  record of what a human approved; `/specd:as-built` copies the pulled markdown
  and authors only the Deviations section.

## Editors other than Claude Code

The skills are portable markdown and the hooks are POSIX shell that reads git
and shells out to `specd` — nothing here is Claude-specific except the manifest
and the hook event names. Ports live behind the same rule as everything else in
this repository: they land when someone runs them, not when someone imagines
them.
