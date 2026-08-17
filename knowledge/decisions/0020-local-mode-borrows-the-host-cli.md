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
