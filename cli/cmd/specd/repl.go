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

// ─── the banner ─────────────────────────────────────────────────────────────

const asciiBanner = `
█████ ████  █████ █████ ████
█     █   █ █     █     █   █
█████ ████  ████  █     █   █
    █ █     █     █     █   █
█████ █     █████ █████ ████ `

var (
	bannerStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("42")).Bold(true)
	dimStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("243"))
)

// printBanner is called once, before the interactive loop starts — never for
// a single-shot subcommand, and never when stdin/stdout is not a terminal.
func printBanner() {
	width, _, err := term.GetSize(int(os.Stdout.Fd()))
	if err != nil {
		width = 80
	}
	if width < 32 || lipgloss.ColorProfile() == termenv.Ascii {
		fmt.Println(dimStyle.Render("specd — spec-driven delivery"))
		fmt.Println()
		return
	}
	fmt.Println(bannerStyle.Render(asciiBanner))
	fmt.Println(dimStyle.Render("  spec-driven delivery · type / for commands, /exit to leave"))
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
}

func newReplModel() *replModel {
	ti := textinput.New()
	ti.Placeholder = "/ for commands"
	ti.Focus()
	ti.Prompt = ""

	delegate := list.NewDefaultDelegate()
	delegate.SetSpacing(0) // 2 rows/item instead of 3 — this is a fast palette, not a browser
	delegate.Styles.SelectedTitle = delegate.Styles.SelectedTitle.Foreground(lipgloss.Color("42")).BorderForeground(lipgloss.Color("42"))
	delegate.Styles.SelectedDesc = delegate.Styles.SelectedDesc.Foreground(lipgloss.Color("108")).BorderForeground(lipgloss.Color("42"))

	items := make([]list.Item, len(replCommands))
	for i, c := range replCommands {
		items[i] = commandItem(c)
	}
	const visibleItems = 7
	l := list.New(items, delegate, 60, visibleItems*2+1)
	l.Title = "commands"
	l.SetShowStatusBar(false)
	l.SetShowHelp(false)
	l.SetFilteringEnabled(false) // filtering is driven by the prompt input, not list.Model's own

	return &replModel{input: ti, list: l}
}

func (m *replModel) Init() tea.Cmd {
	return textinput.Blink
}

func (m *replModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		w := msg.Width
		if w > 70 {
			w = 70
		}
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

func (m *replModel) View() string {
	if m.quitting {
		return ""
	}
	var b strings.Builder
	if m.message != "" {
		b.WriteString(m.message + "\n")
	}
	b.WriteString(bannerStyle.Render("specd") + " " + m.input.View() + "\n")
	if m.showList {
		b.WriteString(m.list.View())
	}
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
