package main

import (
	"fmt"
	"os"
	"strings"

	"github.com/charmbracelet/bubbles/list"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"
	"golang.org/x/term"

	"github.com/specd-dev/specd/cli/internal/api"
	"github.com/specd-dev/specd/cli/internal/config"
)

// The interactive shell (S-104). Bubbletea governs only this: every
// slash command below is a thin adapter over the exact same cmd* functions
// the flag-based switch in main() already calls — same config/token
// loading, same errors, same behavior for direct single-shot use. A command
// runs with the terminal handed back to it via ReleaseTerminal/
// RestoreTerminal, so a function like cmdLogin (which polls and prints
// progress dots) needs no changes at all to work here.
// See knowledge/decisions/0006-cli-repl-bubbletea.md.

type replCommand struct {
	name     string // without the leading "/"
	desc     string
	argLabel string // "" if the command takes no argument
	argIsOpt bool   // true if the (named) argument may be omitted
	run      func(arg string) error
}

var replCommands = []replCommand{
	{name: "help", desc: "show version, project, and auth state", run: func(string) error { runStatus(); return nil }},
	{name: "status", desc: "show version, project, and auth state", run: func(string) error { runStatus(); return nil }},
	{name: "login", desc: "authenticate this machine (device flow)", run: func(string) error { return cmdLogin(nil) }},
	{name: "logout", desc: "forget the stored token", run: func(string) error { return cmdLogout() }},
	{name: "whoami", desc: "show who this machine is signed in as", run: func(string) error { return cmdWhoami() }},
	{name: "projects", desc: "list projects you can see", run: func(string) error { return cmdProjects() }},
	{name: "use", desc: "set the default project for this machine", argLabel: "project", run: func(a string) error { return cmdUse([]string{a}) }},
	{name: "spec-pull", desc: "print an approved spec as markdown", argLabel: "id", run: func(a string) error { _, err := cmdSpec([]string{"pull", a}); return err }},
	{name: "spec-status", desc: "print a spec's lifecycle state", argLabel: "id", run: func(a string) error { _, err := cmdSpec([]string{"status", a}); return err }},
	{name: "specs", desc: "list specs and their states", run: func(string) error { return cmdSpecs(nil) }},
	{name: "connect", desc: "register a local repo with the project", argLabel: "path", argIsOpt: true, run: func(a string) error { return cmdConnect(argsOf(a)) }},
	{name: "runner-pair", desc: "pair this machine as a self-hosted runner", argLabel: "code", run: func(a string) error { return cmdRunnerPair([]string{a}) }},
	{name: "runner-token", desc: "print the stored runner token", run: func(string) error { return cmdRunnerToken() }},
	{name: "open", desc: "open the spec (or project) in the browser", argLabel: "id", argIsOpt: true, run: func(a string) error { return cmdOpen(argsOf(a)) }},
	{name: "exit", desc: "leave the interactive shell", run: nil},
	{name: "quit", desc: "leave the interactive shell", run: nil},
}

func argsOf(a string) []string {
	if a == "" {
		return nil
	}
	return []string{a}
}

func commandByName(name string) (replCommand, bool) {
	name = strings.ToLower(name)
	for _, c := range replCommands {
		if c.name == name {
			return c, true
		}
	}
	return replCommand{}, false
}

// filterCommands is a plain prefix match (not fuzzy) — a partial command
// name narrows the list to commands whose name starts with it.
func filterCommands(cmds []replCommand, prefix string) []replCommand {
	if prefix == "" {
		return cmds
	}
	prefix = strings.ToLower(prefix)
	out := make([]replCommand, 0, len(cmds))
	for _, c := range cmds {
		if strings.HasPrefix(c.name, prefix) {
			out = append(out, c)
		}
	}
	return out
}

// splitSlashInput turns "/use aurora-crm" into ("use", "aurora-crm"), and
// "/use" into ("use", "").
func splitSlashInput(v string) (name, arg string) {
	v = strings.TrimPrefix(v, "/")
	name, arg, _ = strings.Cut(v, " ")
	return strings.TrimSpace(name), strings.TrimSpace(arg)
}

// runStatus is new (T7) — session info, not a mapping of an existing
// command. It reuses the same config/token/Me() primitives cmdWhoami does,
// rather than a bespoke path.
func runStatus() {
	fmt.Printf("specd %s\n", version)
	cfg, err := config.Load()
	if err != nil {
		fmt.Println("config could not be loaded")
		return
	}
	fmt.Printf("server:  %s\n", cfg.API)
	if cfg.Project != "" {
		fmt.Printf("project: %s\n", cfg.Project)
	} else {
		fmt.Println("project: none set — /use <project>")
	}

	token, err := config.LoadToken()
	if err != nil {
		fmt.Println("auth:    not logged in — /login")
		return
	}
	me, err := api.New(cfg.API, token).Me()
	if err != nil {
		fmt.Println("auth:    token stored, but could not verify it right now")
		return
	}
	fmt.Printf("auth:    %s <%s> (%s scope)\n", me.Name, me.Email, me.Audience)
}

// ─── brand ───────────────────────────────────────────────────────────────────
//
// Exact tokens from apps/web/app/globals.css (D12 "minimal monochrome" /
// "Wicked: Glinda and Elphaba" palette) — the CLI's colors are not a
// separate guess at a brand, they are the same hex values the web app
// renders with. The wordmark split (ink "spec" + accent "d") mirrors
// apps/web/components/Logo.tsx's <Wordmark>; the hat glyph below mirrors
// that file's cone+brim silhouette (its "check" variant, which is what
// renders in accent green throughout the app's own nav).

var (
	colorAccent = lipgloss.Color("#00be2c") // phosphor green — the brand accent
	colorInk    = lipgloss.Color("#f2f5f1") // primary text
	colorInk3   = lipgloss.Color("#8ea297") // muted labels

	bannerStyle = lipgloss.NewStyle().Foreground(colorInk).Bold(true)
	accentStyle = lipgloss.NewStyle().Foreground(colorAccent).Bold(true)
	dimStyle    = lipgloss.NewStyle().Foreground(colorInk3)
)

// The mark: a witch's hat, cone tapering to a point over a wide brim —
// same silhouette as Logo.tsx's `cone`/`brim` paths, described in ASCII
// rather than an SVG path.
var hatGlyph = []string{
	"          ▲          ",
	"         ▲▲▲         ",
	"        ▲▲▲▲▲        ",
	"        ▲▲▲▲▲▲▲      ",
	"       ▲▲▲▲▲▲▲▲▲     ",
	"      ▲▲▲▲▲▲▲▲▲▲▲    ",
	"     ▲▲▲▲▲▲▲▲▲▲▲▲▲   ",
	"═════════════════════",
}

// The wordmark, "SPEC" + "D" kept as separate glyph sets so they can be
// colored independently (ink / accent) — same split as the web app's
// spec<i>d</i>. Each letter is a hand-verified 5×5 cell, upscaled 2×.
var wordmarkGlyphs = map[rune][]string{
	'S': {"█████", "█    ", "█████", "    █", "█████"},
	'P': {"████ ", "█   █", "████ ", "█    ", "█    "},
	'E': {"█████", "█    ", "████ ", "█    ", "█████"},
	'C': {"█████", "█    ", "█    ", "█    ", "█████"},
	'D': {"████ ", "█   █", "█   █", "█   █", "████ "},
}

func upscaleGlyph(rows []string, scale int) []string {
	out := make([]string, 0, len(rows)*scale)
	for _, row := range rows {
		var wide strings.Builder
		for _, ch := range row {
			wide.WriteString(strings.Repeat(string(ch), scale))
		}
		for i := 0; i < scale; i++ {
			out = append(out, wide.String())
		}
	}
	return out
}

// renderWordmark renders "SPEC" in ink and "D" in accent, row by row, so
// the two colors sit on one baseline rather than as two separate blocks.
func renderWordmark(scale int) string {
	letters := func(word string) [][]string {
		out := make([][]string, len(word))
		for i, ch := range word {
			out[i] = upscaleGlyph(wordmarkGlyphs[ch], scale)
		}
		return out
	}
	spec := letters("SPEC")
	d := letters("D")
	height := len(spec[0])
	gap := strings.Repeat(" ", scale)

	var lines []string
	for r := 0; r < height; r++ {
		var row strings.Builder
		for i, letter := range spec {
			if i > 0 {
				row.WriteString(gap)
			}
			row.WriteString(letter[r])
		}
		specPart := bannerStyle.Render(row.String())
		dPart := accentStyle.Render(gap + d[0][r])
		lines = append(lines, specPart+dPart)
	}
	return strings.Join(lines, "\n")
}

func renderHat() string {
	lines := make([]string, len(hatGlyph))
	for i, row := range hatGlyph {
		lines[i] = accentStyle.Render(row)
	}
	return strings.Join(lines, "\n")
}

// printBanner is called once, before the interactive loop starts — never for
// a single-shot subcommand, and never when stdin/stdout is not a terminal.
// The hero treatment (mark + big wordmark, boxed) only renders where it can
// actually land well; anything narrower or colorless gets the plain line
// every other terminal still reads correctly.
func printBanner() {
	width, _, err := term.GetSize(int(os.Stdout.Fd()))
	if err != nil {
		width = 80
	}
	if width < 64 || lipgloss.ColorProfile() == termenv.Ascii {
		fmt.Println(dimStyle.Render("specd — spec-driven delivery"))
		fmt.Println()
		return
	}

	hat := lipgloss.PlaceHorizontal(58, lipgloss.Center, renderHat())
	body := hat + "\n\n" + renderWordmark(2) + "\n\n" +
		dimStyle.Render("spec-driven delivery · type / for commands, /exit to leave")

	hero := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(colorAccent).
		Padding(1, 4).
		Render(body)

	fmt.Println(lipgloss.PlaceHorizontal(width, lipgloss.Center, hero))
	fmt.Println()
}

// ─── the Bubbletea model ────────────────────────────────────────────────────

type commandItem replCommand

func (c commandItem) Title() string       { return "/" + c.name }
func (c commandItem) Description() string { return c.desc }
func (c commandItem) FilterValue() string { return c.name }

type commandFinishedMsg struct{}

type replModel struct {
	program     *tea.Program
	input       textinput.Model
	list        list.Model
	showList    bool
	awaitingArg *replCommand
	message     string
	quitting    bool
	width       int
}

const defaultReplWidth = 60

// chatFieldStyle / listBoxStyle are the "bottom chat field" — a bordered
// input box like Claude Code/Gemini CLI/Copilot CLI all use, rather than a
// bare prompt line. The command list renders in the same treatment
// immediately above it, like a floating picker.
var (
	chatFieldStyle = lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(colorAccent).
		Padding(0, 1)
	listBoxStyle = lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(colorInk3).
		Padding(0, 1)
	promptGlyph = accentStyle.Render("❯ ")
)

func newReplModel() *replModel {
	ti := textinput.New()
	ti.Placeholder = "/ for commands"
	ti.Focus()
	ti.Prompt = ""
	ti.TextStyle = lipgloss.NewStyle().Foreground(colorInk)
	ti.PlaceholderStyle = lipgloss.NewStyle().Foreground(colorInk3)
	ti.Cursor.Style = lipgloss.NewStyle().Foreground(colorAccent)

	delegate := list.NewDefaultDelegate()
	delegate.SetSpacing(0) // 2 rows/item instead of 3 — this is a fast palette, not a browser
	delegate.Styles.SelectedTitle = delegate.Styles.SelectedTitle.Foreground(colorAccent).BorderForeground(colorAccent)
	delegate.Styles.SelectedDesc = delegate.Styles.SelectedDesc.Foreground(colorAccent).BorderForeground(colorAccent)

	items := make([]list.Item, len(replCommands))
	for i, c := range replCommands {
		items[i] = commandItem(c)
	}
	const visibleItems = 7
	l := list.New(items, delegate, defaultReplWidth, visibleItems*2+1)
	l.Title = "commands"
	l.Styles.Title = l.Styles.Title.Foreground(colorInk3)
	l.SetShowStatusBar(false)
	l.SetShowHelp(false)
	l.SetFilteringEnabled(false) // filtering is driven by the prompt input, not list.Model's own

	return &replModel{input: ti, list: l, width: defaultReplWidth}
}

func (m *replModel) Init() tea.Cmd {
	return textinput.Blink
}

func (m *replModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		w := msg.Width - 6 // leaves room for the chat field's border + padding
		if w > 70 {
			w = 70
		}
		if w < 20 {
			w = 20
		}
		m.width = w
		m.input.Width = w
		m.list.SetWidth(w)

	case commandFinishedMsg:
		return m, nil

	case tea.KeyMsg:
		switch msg.Type { //nolint:exhaustive
		case tea.KeyCtrlC, tea.KeyCtrlD:
			m.quitting = true
			return m, tea.Quit
		case tea.KeyEsc:
			return m.handleEsc()
		case tea.KeyEnter:
			return m.handleEnter()
		case tea.KeyUp, tea.KeyDown:
			if m.showList {
				var cmd tea.Cmd
				m.list, cmd = m.list.Update(msg)
				return m, cmd
			}
		}
	}

	var cmd tea.Cmd
	m.input, cmd = m.input.Update(msg)
	// Only an actual keystroke should re-filter the list and clear a
	// message — textinput.Blink's periodic cursor tick also flows through
	// here on every message type, and must not wipe a just-shown message a
	// fraction of a second after handleEnter set it.
	if _, ok := msg.(tea.KeyMsg); ok {
		m.syncListFromInput()
	}
	return m, cmd
}

// syncListFromInput is called on every keystroke — it also clears any
// stale message from a previous command. refreshListItems is the same
// list-recompute without that side effect, for callers (like the
// unknown-command path) that need to set their own message afterward.
func (m *replModel) syncListFromInput() {
	m.message = ""
	m.refreshListItems()
}

func (m *replModel) refreshListItems() {
	if m.awaitingArg != nil {
		m.showList = false
		return
	}
	v := m.input.Value()
	if !strings.HasPrefix(v, "/") {
		m.showList = false
		return
	}
	name, _ := splitSlashInput(v)
	m.showList = true
	filtered := filterCommands(replCommands, name)
	items := make([]list.Item, len(filtered))
	for i, c := range filtered {
		items[i] = commandItem(c)
	}
	m.list.SetItems(items)
}

func (m *replModel) handleEsc() (tea.Model, tea.Cmd) {
	if m.awaitingArg != nil {
		m.awaitingArg = nil
		m.input.Placeholder = "/ for commands"
	}
	m.input.SetValue("")
	m.showList = false
	m.message = ""
	return m, nil
}

func (m *replModel) handleEnter() (tea.Model, tea.Cmd) {
	m.message = ""

	if m.awaitingArg != nil {
		c := *m.awaitingArg
		arg := strings.TrimSpace(m.input.Value())
		m.awaitingArg = nil
		m.input.Placeholder = "/ for commands"
		m.input.SetValue("")
		return m, m.execute(c, arg)
	}

	v := strings.TrimSpace(m.input.Value())
	if v == "" {
		return m, nil
	}
	if !strings.HasPrefix(v, "/") {
		m.message = dimStyle.Render("commands start with / — try /")
		return m, nil
	}

	name, arg := splitSlashInput(v)

	if c, ok := commandByName(name); ok {
		m.input.SetValue("")
		m.showList = false
		return m, m.execute(c, arg)
	}

	// Highlighted item in the still-filtered list counts as a selection —
	// "the user selects ... a complete valid command name."
	if m.showList {
		if item, ok := m.list.SelectedItem().(commandItem); ok {
			m.input.SetValue("")
			m.showList = false
			return m, m.execute(replCommand(item), "")
		}
	}

	// No match at all: name the unrecognized command and show every command,
	// not just whatever the dead-end filter left visible.
	m.input.SetValue("/")
	m.refreshListItems()
	m.message = dimStyle.Render(fmt.Sprintf("unknown command %q — showing all commands", "/"+name))
	return m, nil
}

func (m *replModel) execute(c replCommand, arg string) tea.Cmd {
	// /exit and /quit have no underlying cmd* function — quitting is a
	// Bubbletea-level concern (tea.Quit), not something a plain `func() error`
	// can express. This is the single dispatch point every path funnels
	// through (typed in full, filtered down, or arrow-selected from the
	// list), so checking here — rather than string-matching the name earlier
	// — is what keeps all three paths correct without duplicating the check.
	if c.run == nil {
		m.quitting = true
		return tea.Quit
	}
	if c.argLabel != "" && !c.argIsOpt && arg == "" {
		m.awaitingArg = &c
		m.input.Placeholder = c.argLabel + ":"
		m.showList = false
		return nil
	}
	return func() tea.Msg {
		if m.program != nil {
			_ = m.program.ReleaseTerminal()
		}
		fmt.Printf("\n→ /%s%s\n", c.name, func() string {
			if arg == "" {
				return ""
			}
			return " " + arg
		}())
		if err := c.run(arg); err != nil {
			fmt.Fprintf(os.Stderr, "specd: %v\n", err)
		}
		fmt.Println()
		if m.program != nil {
			_ = m.program.RestoreTerminal()
		}
		return commandFinishedMsg{}
	}
}

// View renders the "bottom chat field" — a bordered input box, the way
// Claude Code/Gemini CLI/Copilot CLI all present their prompt, with the
// command list floating in the same treatment directly above it when
// shown. The hero banner is not part of this: it prints once, into normal
// scrollback, before the program starts (see printBanner).
func (m *replModel) View() string {
	if m.quitting {
		return ""
	}

	var b strings.Builder
	if m.showList {
		b.WriteString(listBoxStyle.Width(m.width).Render(m.list.View()))
		b.WriteString("\n")
	}
	if m.message != "" {
		b.WriteString(m.message + "\n")
	}
	b.WriteString(chatFieldStyle.Width(m.width).Render(promptGlyph + m.input.View()))
	b.WriteString("\n")
	return b.String()
}

// runRepl is the entry point for a bare, interactive invocation. It never
// runs for a single-shot subcommand or a non-terminal stdin.
func runRepl() int {
	printBanner()

	m := newReplModel()
	p := tea.NewProgram(m)
	m.program = p

	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "specd: %v\n", err)
		return exitError
	}
	return exitOK
}
