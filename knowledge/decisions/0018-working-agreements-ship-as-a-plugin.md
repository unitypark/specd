# 0018 — The working agreements ship as a plugin, not only as prose

- **Status:** accepted
- **Date:** 2026-08-13
- **Project:** specd

## Context

`AGENTS.md` is seven numbered rules, and the whole product exists to make them
true. specd enforces three of them properly: the server refuses to serve an
unapproved spec (rule 5), the webhook matches merged `spec/<ID>-<slug>` branches
back to the spec (rule 6), and the build station files the as-built record
itself (rule 7).

The remaining enforcement is a markdown file the agent is asked to read. That is
enough right up until it isn't. Nothing stops an agent from opening
`spec/crm-1-widget` and implementing a draft nobody approved — the gate lives at
the server, and an agent editing files never calls the server. Nothing notices
when a spec branch ships code with a stale document beside it. Rule 3 in
particular ("docs ride the change; they never trail it") is the one most easily
lost at the end of a long session, when the code works and stopping feels like
finishing.

Three consecutive engine benchmarks found the same answer to this problem.
[[semantica-analysis]] ships 17 packaged skills, agent personas and hooks that
AST-parse every file the assistant writes; graphify shipped a skill runbook and
`PreToolUse` hooks that redirect an assistant's first file read. Both treat the
working agreements as artifacts that execute, not documents that persuade.

## Decision

Ship the rules as an installable Claude Code plugin, versioned in this
repository, with the repository as its own marketplace.

- **Skills carry the reasoning, not just the commands.** `/specd:pull`,
  `/specd:implement` and `/specd:as-built` are the three moments where the rules
  bind. Each skill says why the order matters — the gate before the branch, the
  knowledge before the code, the verify before the record — because an agent
  that knows only the command will improvise around it at the first surprise.
- **Hooks enforce two rules, and only two.** `gate.sh` blocks a `Write`/`Edit`
  on a `spec/` branch whose spec is not approved. `docs-ride-the-change.sh` asks,
  once, when a spec branch changed code and nothing under `knowledge/`.
- **Fail open on infrastructure, fail closed on a verdict.** This is the whole
  design of `gate.sh`. Missing CLI, not logged in, no project set, server
  unreachable, detached HEAD, not a spec branch — the hook stays out of the way.
  Only exit 3, the server positively saying this spec exists and is not
  approved, blocks anything. A hook that blocks every edit when the API is down
  is a hook people uninstall, and an uninstalled hook enforces nothing.
- **The prompt and the gate stay distinct.** `docs-ride-the-change.sh` asks once
  and accepts the answer: Claude Code sets `stop_hook_active` on the retry, so a
  considered "nothing to document" ends the turn. Conflating a prompt with a
  gate teaches people to disable both.
- **Every verdict except the block is cached.** `Write` and `Edit` fire
  constantly and `specd spec status` is an HTTP round trip, so the answer is
  remembered for a minute and the call is bounded at five seconds. Caching the
  *failures* matters as much as caching the pass: when the API host resolves
  but drops packets, an uncached failure adds the client's full timeout to
  every keystroke, silently, because the hook exits 0 and prints nothing — the
  same "hook people uninstall" outcome as blocking wrongly, reached by a
  quieter road. Only exit 3 stays uncached, because approving a spec has to
  unblock the next edit rather than leave someone waiting out a TTL for work
  they were just cleared to do.
- **The plugin shells out to the CLI; it never re-implements it.** One contract,
  and the exit codes stay the source of truth. Exit 3 was designed so CI could
  gate a build on approval ([[0011-specd-develops-specd]] runs that loop); the
  hook is a second consumer of the same primitive, not a second implementation
  of the same idea.
- **The plugin cannot approve anything.** Approval is a signed-in human in the
  web app, enforced in the service layer, by the `specs_approval_is_attributed`
  database constraint, and by the board UI independently. A plugin that could
  open the gate would defeat the product it ships with.

## Consequences

The rules now bind at the moment they are broken rather than at review time, and
the enforcement is visible in a diff — a hook is code, so it can be tested, and
`packages/templates/src/plugin.test.ts` runs both scripts against a real git
repository with a stubbed CLI on `PATH`.

The cost is a second place the rules are written down. `AGENTS.md` is generated
per repository by `renderAgentsMd`; the plugin is fixed and lives here. They can
drift, and the guard against that is the same one `CLAUDE.md` already uses —
the skills quote the rule numbers rather than restating the rules, so a rule
that changes without its skill changing reads as an obvious mismatch.

Editors other than Claude Code get nothing yet. The skills are portable markdown
and the hooks are POSIX shell over git and `specd`, so a port is small; it lands
when someone runs it, not when someone imagines it. semantica ships eight editor
manifests over one plugin body, which is the shape to copy when a second editor
actually has a user here.

`gate.sh` reads the ticket key out of the branch name, which makes
`specBranchName()`'s format load-bearing in a new place. Keys carry their own
hyphen (`CRM-1`), so the parse takes the first two segments when the second is
numeric; the server upper-cases a ref before lookup, so either case resolves.
