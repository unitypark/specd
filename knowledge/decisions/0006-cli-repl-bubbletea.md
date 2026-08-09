# 0006 — CLI interactive REPL: Bubbletea, default on bare invocation in a TTY

- **Status:** accepted
- **Date:** 2026-08-08
- **Project:** specd

## Context

S-104 ("Improve CLI App like Claude Code or Copilot") asks for a `/`-command
interactive shell in the Go CLI: type `/` to see available commands, filter
by prefix, execute one, with a startup banner and a `/status` view. The CLI
(`cli/`) had zero third-party dependencies before this — `go.mod` had no
`require` block at all — consistent with its own stated design (D13,
`cli/cmd/specd/main.go`'s header comment: "deliberately thin... single
binary").

Two things had to be decided that the spec's own knowledge-base grounding
could not answer, because neither is a shipped pattern anywhere in this
codebase yet: which TUI approach to build the REPL with, and whether the
REPL replaces or sits beside the CLI's existing bare-invocation behavior.

## Decision

**Bubbletea (+ Bubbles for the filterable list, Lipgloss for styling).**
This is an explicit, overriding instruction from the project owner, recorded
here because it is not something inferred from an existing pattern — it is
the first third-party dependency this CLI has ever taken on. The alternative
considered (a plain `bufio.Scanner` loop with hand-rolled ANSI, keeping the
zero-dependency property) was the natural fit for D13's "thin" framing, but
was overridden in favor of the Elm-architecture model Bubbletea provides,
which is a better match for the requirement's List/filter/select interaction
than a lower-level scanner loop would be to build and maintain by hand.

Bubbletea governs **only** the new interactive REPL. Every existing
single-shot invocation (`specd login`, `specd spec pull <id>`, etc.) is
untouched — same flag parsing, same direct `fmt.Print` output, same exit
codes. The REPL's slash-command handlers call the *exact same* unexported
`cmd*` functions in `cli/cmd/specd/main.go` that the flag-based switch
already calls, via `tea.Program.ReleaseTerminal()`/`RestoreTerminal()`
rather than reimplementing them — a blocking, stdout-printing function like
`cmdLogin` (which polls and prints progress dots) runs completely unmodified
with the terminal released to it, then Bubbletea resumes rendering once it
returns. This is what keeps the REPL "a presentation concern... rather than
growing new server-side [or duplicated] behavior" per the spec's own design.

**Default when `specd` runs with no arguments, but only in a TTY.** Bare
`specd` already had defined behavior — print usage, exit `2` — before this
change, and that exit code is documented as CI-significant
(`cli/cmd/specd/main.go`'s exit-code comment block). Something scripted
against today's bare-invocation behavior (a CI step, a Makefile) must not
silently start blocking on an interactive prompt. So: no arguments **and**
stdin is a terminal (`golang.org/x/term.IsTerminal`) launches the REPL; no
arguments and stdin is not a terminal keeps the exact previous behavior
(usage text, exit `2`). This is the same distinction the spec's own banner
requirement already draws for non-interactive invocation — applied here to
the entry point itself, not only to the banner.

**`/status` is a new command, distinct from the existing `spec status
<id>`.** The spec's task list names both `/help`/`/status` (session info:
version, project, auth state) and, unrelated, the CLI already has `spec
status <id>` (a *spec's* lifecycle state). Slash-mapping the existing
capability as `/spec-status <id>` avoids the two colliding under one name.

## Consequences

- `cli/go.mod` gains its first dependencies. `go vet`/`go test` must still
  pass with them present — nothing about "thin, single binary" meant "zero
  dependencies forever," only that the CLI does not embed provider logic or
  database access, which remains true.
- Every existing exit code, flag shape, and non-interactive output is
  unchanged; the REPL is reachable only by a bare, TTY invocation.
- A future job-dispatch-style capability (§9) that lands as a new `cmd*`
  function gets its slash-command mapping "for free" by registering it in
  the same table the REPL already reads from — no parallel dispatcher to
  keep in sync.

## Addendum (2026-08-08) — hero banner and the bottom chat field

The first cut's banner (a small inline wordmark) read as an afterthought
next to Claude Code/Gemini CLI/Copilot CLI's own splash screens, and the
prompt was a bare line rather than the bordered input box all three of
those use. Reworked on direct instruction:

- **Colors are the exact hex tokens from `apps/web/app/globals.css`**
  (`--accent` `#00be2c`, `--ink` `#f2f5f1`, `--ink-3` `#8ea297`), not a
  fresh guess at a terminal palette — `lipgloss.Color("#00be2c")` etc.,
  rendered as true 24-bit color and downgraded automatically by lipgloss on
  terminals that can't do truecolor.
- **The mark is the actual logo**, not a generic banner: an ASCII
  rendition of `apps/web/components/Logo.tsx`'s witch's-hat silhouette
  (cone tapering to a point over a wide brim), in accent green — the same
  "check" variant color treatment the web app's own nav uses. The wordmark
  below it splits color the same way the web app's `<Wordmark>` does:
  "SPEC" in ink, "D" in accent.
- **Both are only printed once**, into normal scrollback before the
  Bubbletea program starts (`printBanner`) — they are not part of `View()`
  and do not redraw on every keystroke. A future scrolling-history viewport
  (were one ever wanted) is a separate, bigger change from this.
- **The chat field is a bordered box** (`chatFieldStyle`,
  `lipgloss.RoundedBorder()` in accent), replacing the old bare prompt
  line. The command list, when shown, renders in the same treatment
  immediately above it — a floating picker, not an inline list.
