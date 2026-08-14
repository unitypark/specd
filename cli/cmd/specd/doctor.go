package main

// `specd doctor` — one command that says what is wrong, in the order you would
// fix it.
//
// specd is a multi-service local product: an API, a database with an extension,
// a vault key, a web app on another origin, an optional model provider, an
// optional embedder, an optional paired runner. When it does not work, the
// failure surfaces as whatever the first thing to break happened to be — a 500
// from a route, a login that hangs, an empty project list — and none of those
// name the cause.
//
// Two rules shape the output:
//
//   - **Report in dependency order and keep going.** A down server makes every
//     later check meaningless, so it is reported first and the rest are marked
//     skipped rather than failed. A wall of red where one thing is wrong is how
//     someone fixes the wrong thing.
//   - **Never call an optional thing broken.** No AI key, no paired runner and
//     the built-in embedder are all supported configurations. They are worth
//     saying out loud, because they change what specd can do — but a warning
//     that fires on a working setup teaches people to ignore warnings.

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/specd-dev/specd/cli/internal/api"
	"github.com/specd-dev/specd/cli/internal/config"
)

type checkState string

const (
	statePass checkState = "pass"
	// A supported configuration worth knowing about — never a defect.
	stateNote checkState = "note"
	stateFail checkState = "fail"
	// Not attempted, because something it depends on already failed.
	stateSkip checkState = "skip"
)

type check struct {
	Name   string     `json:"name"`
	State  checkState `json:"state"`
	Detail string     `json:"detail"`
	// What to do about it. Empty when there is nothing to do.
	Fix string `json:"fix,omitempty"`
}

func (c check) icon() string {
	switch c.State {
	case statePass:
		return "ok  "
	case stateNote:
		return "note"
	case stateSkip:
		return "skip"
	default:
		return "FAIL"
	}
}

// runDoctor gathers every check. Exported shape, no printing: the report is
// assembled first so `--json` and the human rendering cannot drift apart, and
// so the ordering logic is testable without a server.
func runDoctor(cfg *config.Config, token string, tokenErr error) []check {
	checks := []check{{
		Name:   "config",
		State:  statePass,
		Detail: fmt.Sprintf("API %s", cfg.API),
	}}

	client := api.New(cfg.API, token)

	health, err := client.Health()
	serverUp := err == nil
	if err != nil {
		checks = append(checks,
			check{
				Name:   "server",
				State:  stateFail,
				Detail: fmt.Sprintf("cannot reach %s: %v", cfg.API, err),
				Fix:    "start it with `pnpm dev:api`, or point SPECD_API at the right host",
			},
			check{Name: "database", State: stateSkip, Detail: "not checked — the server is unreachable"},
			check{Name: "embeddings", State: stateSkip, Detail: "not checked — the server is unreachable"},
			check{Name: "ai", State: stateSkip, Detail: "not checked — the server is unreachable"},
		)
	} else {
		checks = append(checks, check{
			Name:   "server",
			State:  statePass,
			Detail: fmt.Sprintf("reachable · status %s", health.Status),
		})

		if health.Database == "up" {
			checks = append(checks, check{Name: "database", State: statePass, Detail: "up"})
		} else {
			checks = append(checks, check{
				Name:   "database",
				State:  stateFail,
				Detail: "the server cannot reach Postgres",
				Fix:    "`pnpm infra:up` starts it; `pnpm db:migrate` creates the schema",
			})
		}

		checks = append(checks, embeddingCheck(health.Embeddings))

		if strings.Contains(health.AI, "configured") {
			checks = append(checks, check{
				Name:   "ai",
				State:  statePass,
				Detail: fmt.Sprintf("platform key set · default model %s", health.DefaultModel),
			})
		} else {
			checks = append(checks, check{
				Name:  "ai",
				State: stateNote,
				Detail: "no platform key — projects bring their own key or a paired runner. " +
					"Indexing, retrieval and the graph work without one; drafting and building do not",
			})
		}
	}

	checks = append(checks, identityChecks(client, cfg, token, tokenErr, serverUp)...)
	return checks
}

// The one check that has to explain a ceiling rather than a fault.
func embeddingCheck(name string) check {
	if name == "" {
		return check{Name: "embeddings", State: stateNote, Detail: "the server did not say"}
	}
	if strings.HasPrefix(name, "hash-") {
		return check{
			Name:  "embeddings",
			State: stateNote,
			Detail: name + " — the built-in embedder. It is lexical, so both retrieval arms " +
				"measure similar signals and retrieval has a ceiling this configuration cannot pass",
			Fix: "set SPECD_EMBEDDING_PROVIDER=voyage and VOYAGE_API_KEY to lift it",
		}
	}
	return check{Name: "embeddings", State: statePass, Detail: name}
}

func identityChecks(
	client *api.Client,
	cfg *config.Config,
	token string,
	tokenErr error,
	serverUp bool,
) []check {
	// Identity is a question only the server can answer, so an unreachable
	// server makes it unknowable rather than wrong. Reporting it as a second
	// failure would have someone re-running `specd login` against a host that
	// is not listening — two red lines for one broken thing, which is the
	// failure mode this command exists to avoid.
	if !serverUp {
		return []check{
			{Name: "identity", State: stateSkip, Detail: "not checked — the server is unreachable"},
			{Name: "project", State: stateSkip, Detail: "not checked — the server is unreachable"},
		}
	}

	if token == "" {
		detail := "no token stored"
		if tokenErr != nil {
			detail = tokenErr.Error()
		}
		return []check{
			{Name: "identity", State: stateFail, Detail: detail, Fix: "run `specd login`"},
			{Name: "project", State: stateSkip, Detail: "not checked — no identity"},
		}
	}

	me, err := client.Me()
	if err != nil {
		return []check{
			{
				Name:   "identity",
				State:  stateFail,
				Detail: fmt.Sprintf("the stored token was refused: %v", err),
				Fix:    "run `specd login` again — tokens expire",
			},
			{Name: "project", State: stateSkip, Detail: "not checked — no identity"},
		}
	}

	checks := []check{{
		Name:   "identity",
		State:  statePass,
		Detail: fmt.Sprintf("%s · audience %q (read and report only)", me.Email, me.Audience),
	}}
	return append(checks, projectCheck(client, cfg))
}

func projectCheck(client *api.Client, cfg *config.Config) check {
	if cfg.Project == "" {
		return check{
			Name:   "project",
			State:  stateNote,
			Detail: "no default project on this machine",
			Fix:    "`specd use <project>`, or pass --project per command",
		}
	}

	projects, err := client.Projects()
	if err != nil {
		return check{
			Name:   "project",
			State:  stateFail,
			Detail: fmt.Sprintf("could not list projects: %v", err),
		}
	}
	for _, p := range projects {
		if p.Slug == cfg.Project {
			return check{
				Name:  "project",
				State: statePass,
				Detail: fmt.Sprintf("%s · %d repo(s) · %d spec(s) in review · knowledge health %d%%",
					p.Slug, p.RepoCount, p.SpecsInReview, p.KnowledgeHealth),
			}
		}
	}
	return check{
		Name:   "project",
		State:  stateFail,
		Detail: fmt.Sprintf("%q is set as the default, but this account cannot see it", cfg.Project),
		Fix:    "`specd projects` lists what you can see; `specd use <project>` re-points this machine",
	}
}

// worst reports whether anything actually failed. Notes and skips never make
// the exit code non-zero: a supported configuration is not an error, and a
// check that could not run has already been accounted for by the one that did
// fail.
func anyFailed(checks []check) bool {
	for _, c := range checks {
		if c.State == stateFail {
			return true
		}
	}
	return false
}

func cmdDoctor(args []string) (int, error) {
	asJSON, _ := boolFlag(args, "json")

	cfg, err := config.Load()
	if err != nil {
		return exitError, err
	}
	// Not being logged in is a finding, not a crash — reporting it is most of
	// the point of this command.
	token, tokenErr := config.LoadToken()
	if tokenErr != nil && !errors.Is(tokenErr, config.ErrNotLoggedIn) {
		return exitError, tokenErr
	}

	checks := runDoctor(cfg, token, tokenErr)

	if asJSON {
		out, err := json.MarshalIndent(checks, "", "  ")
		if err != nil {
			return exitError, err
		}
		fmt.Println(string(out))
	} else {
		for _, c := range checks {
			fmt.Printf("%s  %-11s %s\n", c.icon(), c.Name, c.Detail)
			if c.Fix != "" {
				fmt.Printf("              ↳ %s\n", c.Fix)
			}
		}
		if anyFailed(checks) {
			fmt.Println("\nSomething above needs fixing. Work down the list — a failure early on " +
				"makes the checks under it meaningless.")
		} else {
			fmt.Println("\nEverything specd needs is working.")
		}
	}

	if anyFailed(checks) {
		return exitUnhealthy, nil
	}
	return exitOK, nil
}
