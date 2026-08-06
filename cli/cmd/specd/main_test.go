package main

import (
	"testing"

	"github.com/specd-dev/specd/cli/internal/config"
)

// Argument parsing sits under every command, so a bug here misroutes flags
// into positional slots — `specd spec pull --project x CRM-1` pulling a spec
// literally named "--project", for instance.

func TestFlagExtractsValueAndRemovesBoth(t *testing.T) {
	value, rest := flag([]string{"pull", "--project", "aurora", "CRM-1"}, "project")
	if value != "aurora" {
		t.Fatalf("value = %q, want aurora", value)
	}
	if len(rest) != 2 || rest[0] != "pull" || rest[1] != "CRM-1" {
		t.Fatalf("rest = %v, want [pull CRM-1]", rest)
	}
}

func TestFlagSupportsEqualsForm(t *testing.T) {
	value, rest := flag([]string{"--project=aurora", "CRM-1"}, "project")
	if value != "aurora" {
		t.Fatalf("value = %q, want aurora", value)
	}
	if len(rest) != 1 || rest[0] != "CRM-1" {
		t.Fatalf("rest = %v, want [CRM-1]", rest)
	}
}

func TestFlagAbsentLeavesArgsIntact(t *testing.T) {
	value, rest := flag([]string{"pull", "CRM-1"}, "project")
	if value != "" {
		t.Fatalf("value = %q, want empty", value)
	}
	if len(rest) != 2 {
		t.Fatalf("rest = %v, want both args", rest)
	}
}

func TestFlagWithoutValueIsNotConsumed(t *testing.T) {
	// A trailing "--project" with nothing after it must not swallow anything
	// or silently succeed with an empty project.
	value, rest := flag([]string{"CRM-1", "--project"}, "project")
	if value != "" {
		t.Fatalf("value = %q, want empty", value)
	}
	if len(rest) != 2 {
		t.Fatalf("rest = %v, want the args preserved", rest)
	}
}

func TestSingleLetterFlagAcceptsSingleDash(t *testing.T) {
	// `-o out.md` is how it is documented and typed. Matching only `--o` meant
	// the flag was silently dropped and output went to stdout instead.
	value, rest := flag([]string{"CRM-1", "-o", "spec.md"}, "o")
	if value != "spec.md" {
		t.Fatalf("value = %q, want spec.md", value)
	}
	if len(rest) != 1 || rest[0] != "CRM-1" {
		t.Fatalf("rest = %v, want [CRM-1]", rest)
	}
}

func TestSingleLetterFlagAcceptsBothDashFormsAndEquals(t *testing.T) {
	for _, arg := range []string{"-o=spec.md", "--o=spec.md"} {
		value, rest := flag([]string{"CRM-1", arg}, "o")
		if value != "spec.md" {
			t.Fatalf("%s → value = %q, want spec.md", arg, value)
		}
		if len(rest) != 1 {
			t.Fatalf("%s → rest = %v, want [CRM-1]", arg, rest)
		}
	}
	value, _ := flag([]string{"CRM-1", "--o", "spec.md"}, "o")
	if value != "spec.md" {
		t.Fatalf("--o form broke: %q", value)
	}
}

func TestMultiLetterFlagDoesNotMatchSingleDash(t *testing.T) {
	// `-project` should not be treated as `--project`; only single-letter
	// flags get the short form.
	value, rest := flag([]string{"-project", "aurora"}, "project")
	if value != "" {
		t.Fatalf("value = %q, want empty", value)
	}
	if len(rest) != 2 {
		t.Fatalf("rest = %v, want args preserved", rest)
	}
}

func TestBoolFlag(t *testing.T) {
	found, rest := boolFlag([]string{"connect", "--primary", "."}, "primary")
	if !found {
		t.Fatal("expected --primary to be found")
	}
	if len(rest) != 2 || rest[1] != "." {
		t.Fatalf("rest = %v, want [connect .]", rest)
	}

	found, _ = boolFlag([]string{"connect", "."}, "primary")
	if found {
		t.Fatal("did not expect --primary")
	}
}

func TestResolveProjectPrefersExplicitFlag(t *testing.T) {
	cfg := &config.Config{Project: "from-config"}
	project, rest, err := resolveProject([]string{"--project", "explicit", "CRM-1"}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if project != "explicit" {
		t.Fatalf("project = %q, want explicit", project)
	}
	if len(rest) != 1 || rest[0] != "CRM-1" {
		t.Fatalf("rest = %v, want [CRM-1]", rest)
	}
}

func TestResolveProjectFallsBackToConfig(t *testing.T) {
	cfg := &config.Config{Project: "from-config"}
	project, _, err := resolveProject([]string{"CRM-1"}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if project != "from-config" {
		t.Fatalf("project = %q, want from-config", project)
	}
}

func TestResolveProjectExplainsItselfWhenUnset(t *testing.T) {
	_, _, err := resolveProject([]string{"CRM-1"}, &config.Config{})
	if err == nil {
		t.Fatal("expected an error when no project is set anywhere")
	}
	// The message has to tell the user how to fix it, not just that it failed.
	if got := err.Error(); got == "" || !contains(got, "specd use") || !contains(got, "--project") {
		t.Fatalf("unhelpful error: %q", got)
	}
}

func TestTruncateKeepsOutputAligned(t *testing.T) {
	cases := []struct{ in, want string }{
		{"short", "short"},
		{"exactlyten", "exactlyten"},
		{"a much longer title", "a much lo…"},
	}
	for _, c := range cases {
		if got := truncate(c.in, 10); got != c.want {
			t.Fatalf("truncate(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestExitCodesAreDistinct(t *testing.T) {
	// CI gates on these: 3 must never collide with a generic failure, or a
	// pipeline cannot tell "not approved yet" from "something broke".
	seen := map[int]string{}
	for name, code := range map[string]int{
		"ok":          exitOK,
		"error":       exitError,
		"usage":       exitUsage,
		"notApproved": exitNotApprove,
	} {
		if other, dup := seen[code]; dup {
			t.Fatalf("%s and %s share exit code %d", name, other, code)
		}
		seen[code] = name
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (func() bool {
		for i := 0; i+len(needle) <= len(haystack); i++ {
			if haystack[i:i+len(needle)] == needle {
				return true
			}
		}
		return false
	})()
}
