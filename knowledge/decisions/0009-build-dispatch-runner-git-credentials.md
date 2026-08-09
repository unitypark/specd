# 0009 — Build dispatch: the runner uses its own git credentials

- **Status:** accepted
- **Date:** 2026-08-10
- **Project:** specd

## Context

[[0004-runner-job-dispatch]] and [[0005-onboard-job-dispatch]] left `build`
as the one undispatchable job kind, for one stated reason: a build needs a
real git checkout on the runner's machine, and that raises the question of
"how a repo's VCS credential (GitHub App install token / GitLab PAT, today
only ever held by the API process) reaches the runner safely."

Two things about the build station make it different from the other two,
and both were confirmed by reading `BuildAgent.run()` rather than assumed:

1. **The loop is interleaved, not a single call.** `spec` and `onboard`
   each reduce to one model call, which is why their `prepare`/`finalize`
   split works: the server does everything around one opaque request. A
   build is N model calls, each given editing tools pointed at a real
   directory (`ClaudeCodeProvider.code({workspaceDir})`), with a commit
   between them. There is no seam to split at — the filesystem *is* the
   state carried from call to call. So the whole loop moves, or none of it.
2. **Only part of it is git.** Pushing a branch is git. Opening the PR is a
   VCS REST call, which the API already makes with its platform-held token
   and can keep making.

The plan (rev 28, §14a) proposed answering the credential question by
minting per-job short-lived repo-scoped tokens and shipping them to the
runner — the same shape as a GitHub App installation token.

## Decision

**Do not ship credentials to runners. The runner clones and pushes with the
git credentials the machine already has.**

specd sends the runner a clone URL, a base branch, a branch name, the
pre-rendered task prompts and the verify command. It does not send a token,
and the runner does not ask for one. If the machine cannot already clone
and push that repository as itself, the build fails with that as the
message.

The split is therefore: **the runner does the git, the server does the
API.** The runner clones, edits, commits, verifies, files the as-built spec
and pushes the branch. It reports back what it did; the server then opens
the pull or merge request with its own platform token, exactly as the
in-process path does today.

### Why this rather than minting tokens

It is the same trust story the product already tells and sells. D2 says
subscription mode works because the runner drives *its own* logged-in
Claude Code and specd never sees that credential. This is the identical
sentence with one noun changed: the runner uses *its own* git access and
specd never sees that credential either. A runner is a machine the team
already trusts with their code — in practice a developer's laptop or a
team build box, which by definition can already push to these repos.

Minting and shipping tokens would invert that. It would make specd a
credential distribution point: the API would mint write-scoped tokens for
repositories and hand them to machines over the network, and every one of
those is a new thing to scope, expire, rotate, audit and leak. §12's
promise is that "the runner receives short-lived scoped tokens, not the
stored secret" — but the strictly better version of that promise, available
here for free, is that the runner receives *no* token.

It is also less code and less mechanism for a strictly larger capability:
a runner behind a VPN can build a repo the hosted API cannot even reach,
because the runner's own network position and credentials are what apply.
That is the self-managed GitLab case (§11) working by construction rather
than by a special path.

### What this costs, stated plainly

- **Hosted, fleet-owned runners are not this.** A pool of ephemeral
  containers specd owns has no "own credentials" to use, so it would need
  the token-minting design after all. That is D1's hosted-container future
  and should be decided when it is built, against requirements that exist
  then. Nothing here forecloses it — a payload field is where it would go.
- **A misconfigured runner fails at push, late,** after the model work is
  done and paid for. Mitigated by checking push access up front: the runner
  verifies it can reach the remote before the first model call, so a
  credential problem costs a few seconds rather than a full build.
- **`local`-provider repositories are not dispatchable.** Their path is on
  the API host's disk and means nothing on another machine. They keep
  running in-process, which is correct — a local repo and a remote runner
  are contradictory setups.

## Consequences

- `BuildAgent` gains `prepare()`/`finalize()` like the other two agents,
  but with different halves: `prepare()` renders every task prompt and the
  job payload; `finalize()` opens the review surface from the runner's
  report. The middle — the whole edit/commit/verify loop — is the runner's,
  and lives in `apps/runner/src/build.ts`.
- The as-built renderer moved to `@specd/shared`
  (`renderAsBuiltMarkdown`) so both the in-process path and the runner
  produce a byte-identical file. It stays specd's own code either way —
  rule 2 of the build agent ("the as-built spec is written by specd, not by
  the model") is preserved, because a runner is specd, not the model.
- A build runs for minutes, so the claim/report protocol gained a third
  verb: `POST /runners/jobs/:id/progress` appends log lines to the run as
  it goes. Without it a dispatched build is a blank screen until it ends,
  which would make the existing SSE run-log viewer useless for the one job
  kind that most needs it.
- The runner still never touches the database or the knowledge index. The
  trust boundary moved by exactly one thing — the runner now writes to a
  git remote, as itself, which it could already do before specd existed.
- Documented in `docs/runners.md`: a runner must be able to clone and push
  the project's repositories on its own. Teams preferring SSH configure it
  with git's own `url.<base>.insteadOf`, which needs nothing from specd.
