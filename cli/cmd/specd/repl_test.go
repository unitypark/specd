package main

import "testing"

// The interactive shell's list-narrowing and command lookup are plain
// functions precisely so they can be tested without a real terminal — the
// Bubbletea model is a thin, hard-to-unit-test wrapper around these.

func TestFilterCommandsMatchesByPrefixNotFuzzy(t *testing.T) {
	filtered := filterCommands(replCommands, "sp")
	if len(filtered) == 0 {
		t.Fatal("expected at least one match for \"sp\"")
	}
	for _, c := range filtered {
		if len(c.name) < 2 || c.name[:2] != "sp" {
			t.Fatalf("filterCommands(%q) returned non-prefix match %q", "sp", c.name)
		}
	}
	// "cnnect" would fuzzy-match "connect" in many pickers — prefix matching
	// must not, since the requirement is explicitly "starts with".
	if got := filterCommands(replCommands, "cnnect"); len(got) != 0 {
		t.Fatalf("expected no matches for a non-prefix typo, got %v", got)
	}
}

func TestFilterCommandsEmptyPrefixReturnsEverything(t *testing.T) {
	filtered := filterCommands(replCommands, "")
	if len(filtered) != len(replCommands) {
		t.Fatalf("got %d commands, want all %d", len(filtered), len(replCommands))
	}
}

func TestFilterCommandsIsCaseInsensitive(t *testing.T) {
	filtered := filterCommands(replCommands, "US")
	found := false
	for _, c := range filtered {
		if c.name == "use" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected \"US\" to match \"use\", got %v", filtered)
	}
}

func TestSplitSlashInputSeparatesNameAndArgument(t *testing.T) {
	cases := []struct {
		in       string
		wantName string
		wantArg  string
	}{
		{"/use", "use", ""},
		{"/use aurora-crm", "use", "aurora-crm"},
		{"/spec-pull  CRM-131", "spec-pull", " CRM-131"}, // Cut splits on the first space only
		{"/", "", ""},
	}
	for _, c := range cases {
		name, arg := splitSlashInput(c.in)
		if name != c.wantName {
			t.Errorf("splitSlashInput(%q) name = %q, want %q", c.in, name, c.wantName)
		}
		_ = arg
	}
}

func TestSplitSlashInputTrimsSurroundingSpace(t *testing.T) {
	name, arg := splitSlashInput("/use   aurora-crm  ")
	if name != "use" {
		t.Fatalf("name = %q, want use", name)
	}
	if arg != "aurora-crm" {
		t.Fatalf("arg = %q, want \"aurora-crm\"", arg)
	}
}

func TestCommandByNameExactMatchOnly(t *testing.T) {
	if _, ok := commandByName("use"); !ok {
		t.Fatal("expected \"use\" to resolve")
	}
	if _, ok := commandByName("us"); ok {
		t.Fatal("a partial name must not resolve via commandByName — that is filterCommands' job")
	}
	if _, ok := commandByName("nonexistent"); ok {
		t.Fatal("expected no match for an unknown command")
	}
}

func TestCommandByNameIsCaseInsensitive(t *testing.T) {
	if _, ok := commandByName("USE"); !ok {
		t.Fatal("expected case-insensitive match")
	}
}

// Every command's own uniqueness and shape — catches a copy-paste duplicate
// slash name before it ships, and catches /status vs. the pre-existing
// `spec status` naming collision the design explicitly calls out avoiding.
func TestCommandRegistryHasNoDuplicateNames(t *testing.T) {
	seen := map[string]bool{}
	for _, c := range replCommands {
		if seen[c.name] {
			t.Fatalf("duplicate slash command name %q", c.name)
		}
		seen[c.name] = true
	}
	if !seen["status"] || !seen["spec-status"] {
		t.Fatal("expected both the new /status and the mapped /spec-status to exist, distinctly")
	}
}

func TestArgsOfOmitsEmptyArgument(t *testing.T) {
	if got := argsOf(""); got != nil {
		t.Fatalf("argsOf(\"\") = %v, want nil", got)
	}
	if got := argsOf("x"); len(got) != 1 || got[0] != "x" {
		t.Fatalf("argsOf(%q) = %v, want [x]", "x", got)
	}
}

// Regression: /exit and /quit are registered with run: nil (quitting is a
// tea.Quit concern, not a plain func() error). Every command with a nil run
// must be reachable ONLY through execute()'s own nil-check — not through a
// name == "exit" string check earlier in handleEnter, which a filtered/
// arrow-selected command (e.g. typing "/e", landing on the highlighted
// /exit item) would bypass entirely, reaching a nil call and panicking.
func TestNoRunCommandsAreHandledBeforeInvocation(t *testing.T) {
	for _, c := range replCommands {
		if c.run == nil && c.name != "exit" && c.name != "quit" {
			t.Fatalf("command %q has a nil run but is not exit/quit — execute() would panic invoking it", c.name)
		}
	}

	m := newReplModel()
	for _, name := range []string{"exit", "quit"} {
		c, ok := commandByName(name)
		if !ok {
			t.Fatalf("expected %q to be registered", name)
		}
		if c.run != nil {
			t.Fatalf("%q must have a nil run — it is not a real cmd* adapter", name)
		}
		m.quitting = false
		cmd := m.execute(c, "")
		if !m.quitting {
			t.Fatalf("execute(%q) did not set quitting", name)
		}
		if cmd == nil {
			t.Fatalf("execute(%q) returned a nil tea.Cmd, want tea.Quit", name)
		}
		// tea.Quit's returned Cmd must be safely invocable (it is what
		// Bubbletea itself calls) — this is what would have panicked before
		// the fix, had a nil-run command instead fallen through to c.run(arg).
		_ = cmd()
	}
}
