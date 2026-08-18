# 0020 — Local mode borrows the machine's host CLI to open a real review

- **Status:** accepted
- **Date:** 2026-08-17
- **Project:** specd

## Context

Local mode is the trust path: a repository registered by filesystem path, read
and written where it already lives, with no platform credential for any host
(§11, `local-git.adapter.ts`). Its output was a branch and a sentence:

> Committed to branch `specd/setup` in /Users/x/dev/api. Review it with
> `git diff main..specd/setup`, then merge when you are happy. Prefer a pull
> request? Push and open one: `git push -u origin …` → <compare URL>

That is where it stopped, in both places that produce a branch — the setup
scaffold and the build station. The comment in `propose()` said why: *local mode
is the trust path; it does not get to be clever.*

The problem is what it left behind. Almost every repository connected in local
mode is a clone of something — GitHub is the common case — and the team reviews
there, not in a terminal. So the last step of grounding a repository and the
last step of building an approved spec both handed a person homework: two
commands and a URL format, to reach the review surface they already use. A
branch nobody has been asked to look at is not a deliverable, and "merging is
adopting" cannot be the model when merging takes a manual push first.

The obvious fix — store a host token for local-mode projects — is the one thing
this mode exists not to do. A local-mode project has no VCS connection carrying
a credential, and adding one would make local mode a worse version of the hosted
providers rather than a different trade.

## Decision

Where `origin` points at a host we can name, and that host's own CLI (`gh`,
`glab`) is installed **and signed in on this machine**, local mode pushes the
branch and opens a real PR/MR through it. `apps/api/src/vcs/local-review.ts`
owns this; `LocalGitAdapter.propose` and `WorkspaceService.createLocal`'s
`publish` both call it.

The credential belongs to the person running specd, and specd never sees it —
which is the same trade [[0009-build-dispatch-runner-git-credentials]] made for
dispatched builds, and the same shape as subscription mode driving a `claude`
binary that is already signed in. specd holds no new secret as a result of this
decision.

Four properties the implementation is built around:

1. **The CLI is checked before the push, not after.** `hostCliReady` runs
   first, so a repository whose host specd cannot reach is never pushed to.
   Publishing someone's code to a remote is a side effect worth having only
   when it completes in the thing that was asked for.
2. **Only github.com and gitlab.com are recognized** (`detectHost`, shared with
   `hostedCompareUrl` so a link and the CLI that opens the review cannot
   disagree). A self-managed host's software cannot be inferred from its URL,
   and guessing wrong means running `gh` against someone's private git server.
3. **Nothing in this path may fail a run.** The commit is the work; the review
   surface is how it reaches someone. Every failure — no CLI, not signed in,
   rejected push, CLI error — returns a note, and the caller falls back to
   exactly the branch-and-compare-URL hint that existed before. The note is
   included in the hint, because the *absence* of a PR otherwise reads as a
   choice somebody made.
4. **`SPECD_LOCAL_OPEN_PR=0` turns it off.** A machine with a remote it must
   not publish to needs one variable, not a different mode.

An existing PR for the branch is found and returned rather than treated as an
error, mirroring `GitHubAdapter.openPullRequest` — re-grounding a repository
and re-building a spec are both normal things to do.

## Consequences

- Local mode now reaches a review surface in the common case, and the setup and
  build stations behave the same way across all three providers as far as a
  user can see: work lands as a PR you merge.
- The glossary's "output is a branch you diff rather than a PR" is now
  conditional, and says so.
- specd shells out to a binary it does not ship, whose flags it does not
  control. That is contained: the flag set used is small
  (`pr create --base --head --title --body-file -`, `mr create --source-branch
  --target-branch --title --description --yes`), and a flag that stops working
  degrades to the old behaviour with a note rather than to a failed run.
- Local mode still holds the line the comment was defending. It writes to the
  repository the user registered and to the remote that repository already
  points at, with the user's own credentials. It does not acquire a token, a
  webhook, or an account.

## Amendment, 2026-08-17 — a named host may be given a token

Property 2 above says specd will not guess a self-managed host's software from
its URL. That was right, and it left a hole: a repository on a self-managed
GitLab reached the end of every local-mode run with a branch and no review,
because `detectHost` answered null and `glab` is not on most corporate
machines. The fix people asked for is the obvious one — *"I have a token, use
it"* — and the reasoning above does not forbid it. **Guessing** the host is
what was refused. Being **told** the host is not a guess.

So a local-mode project may now carry an optional review credential:
`settings.reviewProvider` plus a token on the `vcs` connection it already owns
(no migration — that row's `encrypted_secret` and `settings.instanceUrl` were
both unused for `provider: 'local'`). When present, `openLocalReview` opens the
review through `GitLabAdapter.openMergeRequest` / `GitHubAdapter.openPullRequest`
instead of a CLI, and the host restriction lifts, because there is nothing left
to infer.

What this deliberately does **not** become is a second VCS connection:

- The token opens a review. It never reads a file, lists a tree, clones, or
  pushes — the machine's own git does the push, exactly as before. Local mode
  still reads and writes the repository on disk.
- It is optional and absent by default. A project without it behaves as this
  decision originally specified, down to the wording of the hint.
- It is proved at connect time (`verify()` on either adapter, mirroring
  `JiraAdapter.verify()`), so a wrong token fails in the wizard rather than as
  a merge request that never appears.

The honest cost: local mode's promise narrows from "specd holds no credential
for your host" to "specd holds no credential for your host unless you give it
one, and then only to open reviews". That is a real change to the sentence, and
it is why the credential is opt-in, single-purpose, and named as such in the
UI rather than folded into the repository form.

## Amendment, 2026-08-18 — GitLab opens the merge request from the push

The credential added above assumed the review has to be opened over an API.
For GitLab it does not. Push options —
`git push -o merge_request.create -o merge_request.title=…` — create the merge
request over the **git transport**, on the same connection the person already
pushes through.

That matters more than convenience. The failure that prompted this was an
access portal answering `/api/v4` with its own login page at 200: a request
that never reaches GitLab, which no token can fix. The git transport is not
intercepted — it is how the repository was cloned in the first place — so the
push route works precisely where the API route cannot.

So the order is now: **push options, then a token, then the host CLI.** The
first needs nothing configured beyond naming the provider, and for GitLab a
token is no longer required at all. GitHub keeps needing one; it has no
push-option equivalent.

Three things this had to get right:

1. **A remote that refuses push options rejects the entire push.** GitLab
   before 11.10, and every non-GitLab remote, send nothing at all. The branch
   still has to arrive, so the push is retried without them and the merge
   request falls to the next strategy.
2. **The description is one argv string**, and a build's body is a page of
   markdown. It is trimmed to 1,500 characters and says that it was, rather
   than risking a push rejected over its own description.
3. **Re-runs.** Push options create; they do not rewrite an open merge
   request's description. A rebuild therefore pushes new commits under a
   description written for the previous run — the staleness `reviewHint` warns
   about elsewhere, and the reason the token path is still worth having.

### The instance URL stopped being something to type

A clone knows its origin, so the host is derivable (`instanceUrlFromRemote`)
and the field is now an override for the three cases a remote cannot express:
a subpath install, plain http, and a non-standard API port. Two bugs were
closed on the way:

- A blank field used to fall through to the adapter default, which sent a
  self-managed project's path and token to **gitlab.com**. It now derives, and
  never falls back to a public host the remote did not name.
- `projectPathFromRemote` compared the instance subpath against `URL.pathname`,
  which has a leading slash, while its scp-syntax branch produced one without.
  A subpath-hosted instance therefore stripped its prefix from an https remote
  and silently kept it on an ssh one — the syntax corporate clones use.

Where a URL is genuinely ambiguous — `https://host/ET130/services/api` is
either a group on a root install or a project on a subpath one — specd asks
instead of guessing: one `GET {candidate}/api/v4/version`, root first, one
segment in on a 404 (`resolveGitLabRoot`).
