<!-- Filed per AGENTS.md rule 7 when S-104 was built. -->
<!-- This is a historical record: never rewrite it. If reality later -->
<!-- diverges, append a "## Deviations" section below.               -->

# S-104 — Improve CLI App like Claude Code or Copilot

> spec v3 · status: approved
> approved by Theo on 2026-08-07T15:53:48.288Z

## Requirements

### As a specd CLI user, I want to type / and see a list of available commands so that I can discover functionality without reading external docs.

- **WHEN** the user types "/" alone in the interactive CLI prompt **THE SYSTEM SHALL** display a list of all available slash commands with a one-line description for each.
- **WHEN** the user types "/" followed by a partial command name **THE SYSTEM SHALL** filter the displayed list to commands whose name starts with that partial string.
- **WHEN** the user selects or types a complete valid command name **THE SYSTEM SHALL** execute that command.
- **IF** the user enters a string starting with "/" that matches no known command **THE SYSTEM SHALL** display an error naming the unrecognized command and SHALL show the list of valid commands.
- **WHILE** the command list is displayed **THE SYSTEM SHALL** allow the user to cancel out of it without executing any command.

### As a specd CLI user, I want each pipeline action exposed as a discrete slash command so that the CLI feels consistent with tools like Claude Code or Copilot CLI.

- **WHERE** the CLI is running in interactive mode **THE SYSTEM SHALL** expose one slash command per existing CLI capability (e.g. connect, login, runner pair).
- **IF** a slash command requires arguments the user omitted **THE SYSTEM SHALL** prompt the user for the missing argument rather than failing silently.
- **WHEN** a slash command is invoked outside the permission or auth state it requires **THE SYSTEM SHALL** reject execution and SHALL display the reason (e.g. not logged in).

### As a specd CLI user, I want a distinctive ASCII art banner on startup so that the CLI has a recognizable, polished identity.

- **WHEN** the interactive CLI starts in a TTY that supports it **THE SYSTEM SHALL** render an ASCII art banner before the first prompt.
- **IF** the CLI is invoked non-interactively (e.g. piped output, CI, or a single-shot subcommand) **THE SYSTEM SHALL** suppress the banner and produce only the requested command's output.
- **IF** the terminal does not support the banner's width or color codes **THE SYSTEM SHALL** fall back to a plain-text banner.

### As a specd CLI user, I want to know what version and mode I'm running so that I can troubleshoot issues.

- **WHEN** the user runs "/help" or "/status" **THE SYSTEM SHALL** display CLI version, connected project (if any), and authentication state.

## Design

- The CLI is a single-binary Go client kept deliberately thin: it does not embed provider logic or Drizzle access, and its tokens are audience-scoped and rejected on authoring/approval routes. A slash-command REPL layer should stay a presentation concern inside this thin client — a command dispatcher mapping `/name` to existing CLI subcommand handlers — rather than growing new server-side behavior. _(per knowledge/decisions/0003-runner-pairing-before-dispatch.md#decision)_
- Per reviewer decision, the interactive REPL and its `/`-command list, filtering, banner, and status views are built with Bubbletea (the Elm-architecture Go TUI framework). This is an explicit, overriding decision from Theo, not something grounded in a shipped pattern in the knowledge base — no excerpt shows an existing TUI dependency in the Go CLI, so adding Bubbletea is a new dependency and should be recorded as its own decision note alongside this spec. _(**UNVERIFIED** — confirm with CLI maintainer that Bubbletea (plus likely Bubbles/Lipgloss companions for lists and styling) is acceptable as a new go.mod dependency and does not conflict with the CLI's "thin, single-binary client" framing (D13))_
- specd already has a device-code interactive flow (`specd login`) with its own prompt/response shape; the new Bubbletea-based slash-command REPL should be built as a superset of that existing interactive surface rather than a parallel entry point, so `/login` invokes the same `AuthService.startDeviceFlow`/`pollDeviceCode` path used today. _(per knowledge/decisions/0003-runner-pairing-before-dispatch.md#context)_
- Runner pairing (`specd runner pair <code>`) is a CLI-invokable capability and should be one of the exposed slash commands (`/runner-pair`) once implemented; if pairing has not shipped by the time this REPL work starts, `/runner-pair` must be omitted from the command list rather than stubbed. _(per knowledge/glossary.md#glossary-unitypark-specd)_
- Which specific CLI subcommands exist today (beyond login and runner pair) and their exact flag/argument shapes are not present in the knowledge base and must be enumerated from the Go CLI source before the command-to-slash mapping table can be finalized. _(**UNVERIFIED** — ask the CLI maintainer / read apps/cli (or equivalent) source for the full current subcommand list)_
- Non-interactive invocation detection (TTY vs. piped/CI) and its effect on banner suppression follows standard CLI practice; Bubbletea programs typically detect this via the `golang.org/x/term` IsTerminal check before entering the Bubbletea event loop, but specd's own convention for this (if any already exists) is not documented in the knowledge base. _(**UNVERIFIED** — confirm existing non-interactive detection convention with CLI maintainer, if one exists, before introducing a new one)_

### Out of scope

- Adding new backend capabilities beyond what the CLI already exposes (e.g. job dispatch, remote runner execution) — see 0003-runner-pairing-before-dispatch, job dispatch is explicitly deferred platform-wide
- Autocomplete/tab-completion beyond the '/' prefix listing
- Theming or user-customizable banners/color schemes
- Non-Go client surfaces (web app UI) mimicking this command style
- Migrating existing non-interactive CLI invocation (flags/single-shot commands) off their current parsing library — Bubbletea only governs the new interactive REPL mode

## Tasks

- [x] **T1** Enumerate existing CLI subcommands and their arguments; produce slash-command mapping table as a design doc — _S · unitypark/specd_
- [x] **T2** Add Bubbletea (+ Bubbles/Lipgloss as needed) as a CLI dependency; record decision note confirming choice per reviewer direction and documenting TTY/non-interactive detection approach — _S · unitypark/specd_
- [x] **T3** Implement Bubbletea root model with `/` command-list view and fuzzy/prefix filtering in the interactive CLI shell — _M · unitypark/specd_
- [x] **T4** Wire each existing CLI capability (login, connect, runner pair if shipped) to its slash command via the Bubbletea dispatcher — _M · unitypark/specd_
- [x] **T5** Add unrecognized-command error handling and missing-argument prompting within the Bubbletea model — _S · unitypark/specd_
- [x] **T6** Add ASCII art startup banner (Bubbletea view) with TTY/CI suppression and plain-text fallback — _S · unitypark/specd_
- [x] **T7** Add `/help`/`/status` command showing version, project, and auth state — _S · unitypark/specd_
- [x] **T8** commit as-built spec → knowledge/specs/S-104-improve-cli-app-like-claude-code-or-copilot.md — _S · unitypark/specd_

## Open questions

- The ticket contains no directive aimed at an AI to ignore; noted only that its phrasing ('make command similar like Claude Code or Copilot style') is a UX preference, not a spec — the concrete command set must come from the current CLI, not from Claude Code/Copilot's own command list.
- What is the full current list of CLI subcommands and their arguments today? Not present in the knowledge base excerpts provided.
- Bubbletea is now fixed as the TUI framework per reviewer decision — does this coexist with, or replace, any existing flag-parsing library used for non-interactive single-shot commands?
- Should the slash-command REPL be the CLI's default mode, or opt-in via a flag/subcommand (e.g. `specd chat`)?
- Is ASCII-art branding to be finalized by design/brand, or is placeholder art acceptable for T6?

## Verification

No repository verify command exists for `cli/` in the onboarding-detected sense; verification here was `go build`, `go vet ./...`, and `go test ./...` (all clean), plus live interactive verification of the actual binary under `tmux` — banner rendering, `/`-list display, prefix filtering, arrow-key selection, missing-argument prompting, inline-argument execution, unrecognized-command handling, and `/exit` were each driven and observed directly, not just read from source. That pass caught and fixed two bugs a unit test would not have: an inverted color-profile check that always fell back to the plain-text banner, and a cursor-blink tick that silently cleared the "unknown command" message a fraction of a second after it was set.

## Deviations / implementation notes

- **Open question resolved:** the REPL is the default when `specd` is run with no arguments, but only when stdin is a terminal — a non-interactive invocation (no args, not a TTY) keeps the exact prior behavior (usage text, exit 2), so nothing scripted against today's bare invocation breaks. Decided directly with the project owner outside the spec's own comment thread; see `knowledge/decisions/0006-cli-repl-bubbletea.md`.
- **Open question resolved:** existing non-interactive, flag-based single-shot commands (`specd login`, `specd spec pull <id>`, etc.) are entirely untouched — same parsing, same output, same exit codes. Bubbletea governs only the new interactive shell.
- **`/status` vs. the pre-existing `spec status <id>`:** kept deliberately distinct — the existing capability is mapped as `/spec-status <id>` (a spec's lifecycle state); `/status` (and `/help`, per the requirement) is the new session-info view (version, project, auth). Documented in `knowledge/decisions/0006-cli-repl-bubbletea.md` so the naming choice doesn't need re-deriving later.
- **T1's design doc** is `docs/cli-repl.md`, which also serves as the interactive shell's user-facing usage documentation.
