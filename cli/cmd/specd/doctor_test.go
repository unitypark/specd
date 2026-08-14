package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/specd-dev/specd/cli/internal/config"
)

func byName(checks []check, name string) check {
	for _, c := range checks {
		if c.Name == name {
			return c
		}
	}
	return check{Name: name, State: "missing"}
}

// A doctor that reports a supported configuration as broken is a doctor people
// stop running. Nothing optional may set the exit code.
func TestOptionalConfigurationIsNeverAFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/health"):
			_, _ = w.Write([]byte(`{"status":"ok","database":"up","ai":"no platform key (BYO key per project)","embeddings":"hash-ngram-v1","defaultModel":"claude-opus-5"}`))
		case strings.HasSuffix(r.URL.Path, "/auth/me"):
			_, _ = w.Write([]byte(`{"id":"u1","email":"t@t","name":"Theo","audience":"cli"}`))
		default:
			_, _ = w.Write([]byte(`[]`))
		}
	}))
	defer srv.Close()

	checks := runDoctor(&config.Config{API: srv.URL}, "token", nil)

	// No platform key, the built-in embedder and no default project are all
	// supported ways to run specd.
	for _, name := range []string{"ai", "embeddings", "project"} {
		if got := byName(checks, name).State; got != stateNote {
			t.Errorf("%s = %q, want %q", name, got, stateNote)
		}
	}
	if anyFailed(checks) {
		t.Fatal("a working install reported a failure")
	}
}

// The ceiling is the honest thing to say about the built-in embedder: it is not
// broken, and it is not as good as it gets.
func TestTheBuiltInEmbedderReportsItsCeiling(t *testing.T) {
	c := embeddingCheck("hash-ngram-v1")
	if c.State != stateNote {
		t.Fatalf("state = %q, want %q — it works, it is just bounded", c.State, stateNote)
	}
	if !strings.Contains(c.Detail, "ceiling") {
		t.Errorf("does not name the ceiling: %q", c.Detail)
	}
	if !strings.Contains(c.Fix, "SPECD_EMBEDDING_PROVIDER") {
		t.Errorf("does not say how to lift it: %q", c.Fix)
	}

	// A real provider is simply fine, with nothing to caveat.
	if got := embeddingCheck("voyage-3.5").State; got != statePass {
		t.Errorf("voyage = %q, want %q", got, statePass)
	}
}

// One thing wrong should read as one thing wrong. Everything downstream of an
// unreachable server is skipped, not failed, or the reader fixes the wrong item.
func TestAnUnreachableServerSkipsWhatItMakesUnknowable(t *testing.T) {
	checks := runDoctor(&config.Config{API: "http://127.0.0.1:1"}, "token", nil)

	if got := byName(checks, "server").State; got != stateFail {
		t.Fatalf("server = %q, want %q", got, stateFail)
	}
	for _, name := range []string{"database", "embeddings", "ai"} {
		if got := byName(checks, name).State; got != stateSkip {
			t.Errorf("%s = %q, want %q — it was never checked", name, got, stateSkip)
		}
	}
	// Exactly one thing is actually broken, and it names the fix.
	failed := 0
	for _, c := range checks {
		if c.State == stateFail {
			failed++
		}
	}
	if failed != 1 {
		t.Fatalf("%d failures for one unreachable server", failed)
	}
	if !strings.Contains(byName(checks, "server").Fix, "pnpm dev:api") {
		t.Error("does not say how to start the server")
	}
}

func TestNotLoggedInIsReportedRatherThanCrashing(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status":"ok","database":"up","ai":"configured","embeddings":"voyage-3.5"}`))
	}))
	defer srv.Close()

	checks := runDoctor(&config.Config{API: srv.URL}, "", config.ErrNotLoggedIn)

	identity := byName(checks, "identity")
	if identity.State != stateFail {
		t.Fatalf("identity = %q, want %q", identity.State, stateFail)
	}
	if !strings.Contains(identity.Fix, "specd login") {
		t.Errorf("does not name the fix: %q", identity.Fix)
	}
	// And the server it could reach is still reported as fine — the two are
	// different problems.
	if byName(checks, "server").State != statePass {
		t.Error("a reachable server was not reported as reachable")
	}
	if byName(checks, "project").State != stateSkip {
		t.Error("project should be skipped without an identity, not failed")
	}
}

func TestADefaultProjectThisAccountCannotSeeIsAFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/health"):
			_, _ = w.Write([]byte(`{"status":"ok","database":"up","ai":"configured","embeddings":"voyage-3.5"}`))
		case strings.HasSuffix(r.URL.Path, "/auth/me"):
			_, _ = w.Write([]byte(`{"id":"u1","email":"t@t","name":"Theo","audience":"cli"}`))
		default:
			_, _ = w.Write([]byte(`[{"slug":"other","name":"Other","repoCount":1}]`))
		}
	}))
	defer srv.Close()

	checks := runDoctor(&config.Config{API: srv.URL, Project: "aurora"}, "token", nil)
	project := byName(checks, "project")
	if project.State != stateFail {
		t.Fatalf("project = %q, want %q", project.State, stateFail)
	}
	if !strings.Contains(project.Detail, "aurora") {
		t.Errorf("does not name the project: %q", project.Detail)
	}
}

func TestAHealthyInstallPassesEverything(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/health"):
			_, _ = w.Write([]byte(`{"status":"ok","database":"up","ai":"configured","embeddings":"voyage-3.5","defaultModel":"claude-opus-5"}`))
		case strings.HasSuffix(r.URL.Path, "/auth/me"):
			_, _ = w.Write([]byte(`{"id":"u1","email":"t@t","name":"Theo","audience":"cli"}`))
		default:
			_, _ = w.Write([]byte(`[{"slug":"aurora","name":"Aurora","repoCount":2,"specsInReview":1,"knowledgeHealth":88}]`))
		}
	}))
	defer srv.Close()

	checks := runDoctor(&config.Config{API: srv.URL, Project: "aurora"}, "token", nil)
	for _, c := range checks {
		if c.State != statePass {
			t.Errorf("%s = %q on a healthy install: %s", c.Name, c.State, c.Detail)
		}
	}
	if anyFailed(checks) {
		t.Fatal("a healthy install would exit non-zero")
	}
}
