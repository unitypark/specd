// Command specd is the CLI half of the specd platform.
//
// It is deliberately thin (D13): it fetches specs, registers repositories and
// reports status. It never authors, reviews or approves — the gate and the
// review surface stay in the app, and the server enforces that regardless of
// what this binary asks for.
package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"golang.org/x/term"

	"github.com/specd-dev/specd/cli/internal/api"
	"github.com/specd-dev/specd/cli/internal/config"
)

const version = "0.1.0"

// Exit codes, chosen so CI can gate a build on spec approval:
//
//	0  fine
//	1  something went wrong
//	2  usage error
//	3  the spec exists but is not approved  ← the interesting one
const (
	exitOK         = 0
	exitError      = 1
	exitUsage      = 2
	exitNotApprove = 3
)

func main() {
	args := os.Args[1:]
	if len(args) == 0 {
		// A bare invocation launches the interactive shell (S-104) — but only
		// in a real terminal. Piped/CI/non-interactive callers must keep
		// getting exactly today's behavior (usage text, exit 2): the REPL
		// would otherwise sit blocking on a stdin that never sends anything.
		if term.IsTerminal(int(os.Stdin.Fd())) {
			os.Exit(runRepl())
		}
		usage()
		os.Exit(exitUsage)
	}

	var err error
	code := exitOK

	switch args[0] {
	case "login":
		err = cmdLogin(args[1:])
	case "logout":
		err = cmdLogout()
	case "whoami":
		err = cmdWhoami()
	case "projects":
		err = cmdProjects()
	case "use":
		err = cmdUse(args[1:])
	case "spec":
		code, err = cmdSpec(args[1:])
	case "specs":
		err = cmdSpecs(args[1:])
	case "connect":
		err = cmdConnect(args[1:])
	case "runner":
		err = cmdRunner(args[1:])
	case "open":
		err = cmdOpen(args[1:])
	case "version", "--version", "-v":
		fmt.Printf("specd %s\n", version)
	case "help", "--help", "-h":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n", args[0])
		usage()
		os.Exit(exitUsage)
	}

	if err != nil {
		fmt.Fprintf(os.Stderr, "specd: %v\n", err)
		if code == exitOK {
			code = exitError
		}
	}
	os.Exit(code)
}

func usage() {
	fmt.Print(`specd — spec-driven delivery

  specd                           interactive shell (type / for commands) — TTY only

  specd login                    authenticate this machine (device flow)
  specd logout                   forget the stored token
  specd whoami                   show who this machine is signed in as

  specd projects                 list projects you can see
  specd use <project>            set the default project for this machine

  specd spec pull <id>           print an approved spec as markdown
  specd spec status <id>         print lifecycle state (exit 3 if unapproved)
  specd specs list               list specs and their states

  specd connect [path]           register a local repo with the project
  specd runner pair <code>       pair this machine as a self-hosted runner
  specd runner token             print the stored runner token (for SPECD_RUNNER_TOKEN)
  specd open [id]                open the spec (or project) in the browser

Flags:
  --project <slug>               override the default project
  --json                         machine-readable output where supported
  -o <file>                      write `+"`spec pull`"+` output to a file

Environment:
  SPECD_API                      API base URL (default http://localhost:4000/api)
  SPECD_PROJECT                  default project slug
  SPECD_TOKEN                    token to use instead of the stored one
  SPECD_WEB                      web app origin (learned at login; used by open)
  SPECD_RUNNER_TOKEN             runner token to use instead of the paired one

Specs are pulled only when approved. That is enforced by the server, not here.
`)
}

// ─── helpers ─────────────────────────────────────────────────────────────────

func client() (*api.Client, *config.Config, error) {
	cfg, err := config.Load()
	if err != nil {
		return nil, nil, err
	}
	token, err := config.LoadToken()
	if err != nil {
		return nil, nil, err
	}
	return api.New(cfg.API, token), cfg, nil
}

// flag pulls "--name value" out of args, returning the value and the remainder.
//
// Single-letter names also match the single-dash form, because that is how
// they are documented and typed (`-o out.md`). Accepting only `--o` meant the
// flag was silently ignored and the output went to stdout instead of the file.
func flag(args []string, name string) (string, []string) {
	forms := []string{"--" + name}
	if len(name) == 1 {
		forms = append(forms, "-"+name)
	}

	matches := func(arg string) bool {
		for _, f := range forms {
			if arg == f {
				return true
			}
		}
		return false
	}
	prefixed := func(arg string) (string, bool) {
		for _, f := range forms {
			if strings.HasPrefix(arg, f+"=") {
				return strings.TrimPrefix(arg, f+"="), true
			}
		}
		return "", false
	}

	out := make([]string, 0, len(args))
	value := ""
	for i := 0; i < len(args); i++ {
		if matches(args[i]) && i+1 < len(args) {
			value = args[i+1]
			i++
			continue
		}
		if v, ok := prefixed(args[i]); ok {
			value = v
			continue
		}
		out = append(out, args[i])
	}
	return value, out
}

func boolFlag(args []string, name string) (bool, []string) {
	out := make([]string, 0, len(args))
	found := false
	for _, a := range args {
		if a == "--"+name {
			found = true
			continue
		}
		out = append(out, a)
	}
	return found, out
}

func resolveProject(args []string, cfg *config.Config) (string, []string, error) {
	override, rest := flag(args, "project")
	if override != "" {
		return override, rest, nil
	}
	if cfg.Project != "" {
		return cfg.Project, rest, nil
	}
	return "", rest, errors.New("no project set — use `specd use <project>` or pass --project")
}

// ─── commands ────────────────────────────────────────────────────────────────

func cmdLogin(args []string) error {
	apiURL, _ := flag(args, "api")
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if apiURL != "" {
		cfg.API = apiURL
	}

	c := api.New(cfg.API, "")
	start, err := c.StartDeviceFlow()
	if err != nil {
		return err
	}

	fmt.Printf("\n  Your code:  %s\n\n", start.UserCode)
	fmt.Printf("  Open %s and enter it.\n", start.VerificationURI)
	_ = openBrowser(start.VerificationURI)
	fmt.Print("\n  Waiting for confirmation")

	interval := time.Duration(start.Interval) * time.Second
	if interval <= 0 {
		interval = 3 * time.Second
	}
	deadline := time.Now().Add(time.Duration(start.ExpiresIn) * time.Second)

	for time.Now().Before(deadline) {
		time.Sleep(interval)
		fmt.Print(".")
		token, err := c.PollDeviceFlow(start.DeviceCode)
		if err != nil {
			fmt.Println()
			return err
		}
		if token == "" {
			continue
		}

		if err := config.SaveToken(token); err != nil {
			fmt.Println()
			return err
		}
		if err := cfg.Save(); err != nil {
			fmt.Println()
			return err
		}

		me, err := api.New(cfg.API, token).Me()
		fmt.Println()
		if err != nil {
			return err
		}
		// Remember where the app lives so `specd open` goes to the right place.
		if me.WebOrigin != "" {
			cfg.WebOrigin = me.WebOrigin
			if err := cfg.Save(); err != nil {
				return err
			}
		}
		fmt.Printf("\n  Signed in as %s <%s>.\n", me.Name, me.Email)
		fmt.Printf("  Token stored%s.\n\n", keychainNote())
		return nil
	}

	fmt.Println()
	return errors.New("login timed out — run `specd login` again")
}

func keychainNote() string {
	if runtime.GOOS == "darwin" {
		return " in your login keychain"
	}
	return " (0600) in your config directory"
}

func cmdLogout() error {
	if err := config.ClearToken(); err != nil {
		return err
	}
	fmt.Println("Signed out.")
	return nil
}

func cmdWhoami() error {
	c, cfg, err := client()
	if err != nil {
		return err
	}
	me, err := c.Me()
	if err != nil {
		return err
	}
	fmt.Printf("%s <%s>\n", me.Name, me.Email)
	fmt.Printf("server:  %s\n", cfg.API)
	fmt.Printf("token:   %s scope\n", me.Audience)
	if cfg.Project != "" {
		fmt.Printf("project: %s\n", cfg.Project)
	}
	return nil
}

func cmdProjects() error {
	c, _, err := client()
	if err != nil {
		return err
	}
	projects, err := c.Projects()
	if err != nil {
		return err
	}
	if len(projects) == 0 {
		fmt.Println("No projects yet. Create one in the app.")
		return nil
	}
	for _, p := range projects {
		fmt.Printf("%-28s %-24s %d repos · %d in review · knowledge %d%%\n",
			p.Slug, truncate(p.Name, 22), p.RepoCount, p.SpecsInReview, p.KnowledgeHealth)
	}
	return nil
}

func cmdUse(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: specd use <project>")
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	// Verify the slug resolves before pinning it, so a typo fails now rather
	// than on every later command.
	token, err := config.LoadToken()
	if err != nil {
		return err
	}
	projects, err := api.New(cfg.API, token).Projects()
	if err != nil {
		return err
	}
	for _, p := range projects {
		if p.Slug == args[0] {
			cfg.Project = p.Slug
			if err := cfg.Save(); err != nil {
				return err
			}
			fmt.Printf("Default project: %s (%s)\n", p.Name, p.Slug)
			return nil
		}
	}
	return fmt.Errorf("no project %q that you can see", args[0])
}

func cmdSpec(args []string) (int, error) {
	if len(args) == 0 {
		return exitUsage, errors.New("usage: specd spec <pull|status> <id>")
	}

	cfg, err := config.Load()
	if err != nil {
		return exitError, err
	}
	project, rest, err := resolveProject(args[1:], cfg)
	if err != nil {
		return exitError, err
	}

	token, err := config.LoadToken()
	if err != nil {
		return exitError, err
	}
	c := api.New(cfg.API, token)

	switch args[0] {
	case "pull":
		outFile, rest := flag(rest, "o")
		if len(rest) == 0 {
			return exitUsage, errors.New("usage: specd spec pull <id>")
		}
		markdown, err := c.SpecPull(project, rest[0])
		if err != nil {
			var apiErr *api.APIError
			if errors.As(err, &apiErr) && apiErr.NotApproved() {
				return exitNotApprove, err
			}
			return exitError, err
		}
		if outFile != "" {
			if err := os.WriteFile(outFile, []byte(markdown), 0o644); err != nil {
				return exitError, err
			}
			fmt.Fprintf(os.Stderr, "wrote %s\n", outFile)
			return exitOK, nil
		}
		fmt.Print(markdown)
		return exitOK, nil

	case "status":
		asJSON, rest := boolFlag(rest, "json")
		if len(rest) == 0 {
			return exitUsage, errors.New("usage: specd spec status <id>")
		}
		st, err := c.SpecStatus(project, rest[0])
		if err != nil {
			return exitError, err
		}
		if asJSON {
			fmt.Printf(`{"key":%q,"version":%d,"status":%q,"buildable":%t}`+"\n",
				st.TicketKey, st.Version, st.Status, st.Buildable)
		} else {
			fmt.Printf("%s  v%d  %s\n", st.TicketKey, st.Version, st.Status)
			if st.ApprovedBy != "" {
				fmt.Printf("approved by %s at %s\n", st.ApprovedBy, st.ApprovedAt)
			}
		}
		// Exit 3 lets a pipeline block a build until its spec is approved.
		if !st.Buildable {
			return exitNotApprove, nil
		}
		return exitOK, nil

	default:
		return exitUsage, fmt.Errorf("unknown subcommand %q — try pull or status", args[0])
	}
}

func cmdSpecs(args []string) error {
	if len(args) > 0 && args[0] != "list" {
		return fmt.Errorf("unknown subcommand %q — try list", args[0])
	}
	rest := args
	if len(args) > 0 {
		rest = args[1:]
	}

	cfg, err := config.Load()
	if err != nil {
		return err
	}
	project, rest, err := resolveProject(rest, cfg)
	if err != nil {
		return err
	}
	status, _ := flag(rest, "status")

	token, err := config.LoadToken()
	if err != nil {
		return err
	}
	specs, err := api.New(cfg.API, token).Specs(project, status)
	if err != nil {
		return err
	}
	if len(specs) == 0 {
		fmt.Println("No specs yet.")
		return nil
	}
	for _, s := range specs {
		approver := ""
		if s.ApprovedBy != "" {
			approver = " · " + s.ApprovedBy
		}
		fmt.Printf("%-10s v%-2d %-18s %-34s %d cites, %d unverified%s\n",
			s.Key, s.Version, s.Status, truncate(s.Title, 32), s.Citations, s.Unverified, approver)
	}
	return nil
}

func cmdConnect(args []string) error {
	primary, args := boolFlag(args, "primary")
	name, args := flag(args, "name")

	cfg, err := config.Load()
	if err != nil {
		return err
	}
	project, args, err := resolveProject(args, cfg)
	if err != nil {
		return err
	}

	path := "."
	if len(args) > 0 {
		path = args[0]
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	if name == "" {
		name = filepath.Base(abs)
	}

	token, err := config.LoadToken()
	if err != nil {
		return err
	}
	res, err := api.New(cfg.API, token).Connect(project, abs, name, primary)
	if err != nil {
		return err
	}
	if !res.OK {
		return fmt.Errorf("%s: %s", abs, res.Reason)
	}

	fmt.Printf("Registered %s", res.Repository.Name)
	if res.Repository.IsPrimary {
		fmt.Print(" (primary)")
	}
	fmt.Printf("\n  %s\n", abs)
	if !res.Clean {
		fmt.Println("  note: working tree is dirty — commit or stash before running setup")
	}
	fmt.Println("\nCode never leaves this machine. Run setup from the app to scaffold knowledge/.")
	return nil
}

func cmdRunner(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: specd runner pair <code> | specd runner token")
	}
	switch args[0] {
	case "pair":
		return cmdRunnerPair(args[1:])
	case "token":
		return cmdRunnerToken()
	default:
		return errors.New("usage: specd runner pair <code> | specd runner token")
	}
}

// cmdRunnerToken prints the stored runner token so it can be handed to the
// job-polling daemon (`apps/runner`), which runs as a separate process and
// has no keychain access of its own: `SPECD_RUNNER_TOKEN=$(specd runner token) specd-runner`.
func cmdRunnerToken() error {
	token, err := config.LoadRunnerToken()
	if err != nil {
		return err
	}
	fmt.Println(token)
	return nil
}

// cmdRunnerPair completes the handshake and verifies the two things it
// promises to: that the code was valid, and that this machine can actually
// reach the API outbound. It does not run any jobs — pairing only stores the
// credential. Executing work is the @specd/runner daemon's job, started
// separately with the token `specd runner token` prints.
func cmdRunnerPair(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: specd runner pair <code>")
	}

	cfg, err := config.Load()
	if err != nil {
		return err
	}

	result, err := api.New(cfg.API, "").PairRunner(args[0])
	if err != nil {
		return err
	}
	if err := config.SaveRunnerToken(result.Token); err != nil {
		return err
	}

	fmt.Printf("Paired with project %s.\n", result.Project)
	fmt.Printf("Runner token stored%s.\n", keychainNote())

	if err := api.New(cfg.API, result.Token).RunnerHeartbeat(); err != nil {
		fmt.Fprintf(os.Stderr, "\nPaired, but the connectivity check failed: %v\n", err)
		fmt.Fprintln(os.Stderr, "The token is stored; retry the check once the network issue is fixed.")
		return nil
	}
	fmt.Println("Outbound connectivity to the API: OK.")
	fmt.Println("\nThis machine is paired but idle. Start the daemon to run jobs on it:")
	fmt.Println("  SPECD_RUNNER_TOKEN=$(specd runner token) pnpm --filter @specd/runner start")
	return nil
}

func cmdOpen(args []string) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	project, args, err := resolveProject(args, cfg)
	if err != nil {
		return err
	}

	web := cfg.WebOrigin
	if web == "" {
		// Not learned yet (config predates login, or SPECD_TOKEN was used
		// directly). Ask the server rather than guessing from the API URL —
		// they are different origins.
		if token, err := config.LoadToken(); err == nil {
			if me, err := api.New(cfg.API, token).Me(); err == nil && me.WebOrigin != "" {
				web = me.WebOrigin
				cfg.WebOrigin = web
				_ = cfg.Save()
			}
		}
	}
	if web == "" {
		return errors.New("don't know where the web app is — run `specd login`, or set SPECD_WEB")
	}
	web = strings.TrimSuffix(web, "/")

	target := fmt.Sprintf("%s/p/%s/board", web, project)
	if len(args) > 0 {
		target = fmt.Sprintf("%s/p/%s/board?spec=%s", web, project, args[0])
	}
	fmt.Println(target)
	return openBrowser(target)
}

func openBrowser(target string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", target)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", target)
	default:
		cmd = exec.Command("xdg-open", target)
	}
	return cmd.Start()
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	if n <= 1 {
		return s[:n]
	}
	return s[:n-1] + "…"
}
