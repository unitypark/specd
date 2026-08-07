# CLI interactive shell

A bare `specd` invocation, in a real terminal, launches an interactive
shell: type `/` to see every available command, keep typing to narrow it by
prefix, select one and run it. Everything non-interactive — `specd login`,
`specd spec pull <id>`, flags, exit codes — is completely unchanged; the
shell is a new, additional way in, not a replacement for the existing one.

```bash
specd
```

```
 ████ ...          (ASCII banner — plain-text fallback below a certain
                     terminal width, or when color isn't supported)
  spec-driven delivery · type / for commands, /exit to leave

specd / for commands
```

Piped, scripted, or CI invocations are untouched: `specd` with no arguments
and a non-terminal stdin still prints usage and exits `2`, exactly as
before — the shell only ever starts in a real TTY.

## The command-to-slash mapping (S-104 T1)

Every slash command is a thin adapter over the *same* unexported `cmd*`
function the flag-based switch in `main()` already calls — same
`config.Load()`/`config.LoadToken()`, same errors, same behavior. The shell
hands a command's underlying function the real terminal (via
`tea.Program.ReleaseTerminal`/`RestoreTerminal`) rather than reimplementing
it, so a function like `cmdLogin` — which polls and prints progress dots —
needed no changes at all to work here.

| Slash command | Existing capability | Argument |
|---|---|---|
| `/help`, `/status` | _(new — not a mapping)_ | |
| `/login` | `specd login` | |
| `/logout` | `specd logout` | |
| `/whoami` | `specd whoami` | |
| `/projects` | `specd projects` | |
| `/use` | `specd use <project>` | `project` (required) |
| `/spec-pull` | `specd spec pull <id>` | `id` (required) |
| `/spec-status` | `specd spec status <id>` | `id` (required) |
| `/specs` | `specd specs list` | |
| `/connect` | `specd connect [path]` | `path` (optional) |
| `/runner-pair` | `specd runner pair <code>` | `code` (required) |
| `/runner-token` | `specd runner token` | |
| `/open` | `specd open [id]` | `id` (optional) |
| `/exit`, `/quit` | leave the shell | |

`/status` is deliberately **not** the same thing as the existing `spec
status <id>` (a *spec's* lifecycle state) — that stays mapped as
`/spec-status <id>`. `/status` (and `/help`, which does the same thing —
see the requirement) is new: CLI version, connected project, and auth state.
See `knowledge/decisions/0006-cli-repl-bubbletea.md` for why.

A command needing an argument you didn't supply inline (`/use` alone, or
selecting it from the list with nothing typed after it) prompts for it —
it does not fail silently. `/use aurora-crm` in one line skips the prompt.

## Interaction

- **`/`** — show every command.
- **keep typing** — narrows the list to commands whose name starts with
  what you've typed (plain prefix match, not fuzzy).
- **↑ / ↓** — move the highlight.
- **Enter** — run the highlighted command, or whatever you've typed if it
  exactly matches a command name.
- **Esc** — cancel out of the list (or a pending argument prompt) without
  running anything.
- **Ctrl+C / Ctrl+D / `/exit` / `/quit`** — leave the shell.

An unrecognized `/whatever` names the problem and shows the full command
list again, rather than just going quiet.

## Adding a new command

Register it in `replCommands` in `cli/cmd/specd/repl.go` — name, one-line
description, an argument label if it needs one, and a `func(arg string)
error` that calls the existing `cmd*` function. That's the whole mapping;
list rendering, filtering, argument-prompting, and dispatch all read from
the same table.
