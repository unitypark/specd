# 0002 — GitLab via personal/project access token, not an OAuth app

- **Status:** accepted
- **Date:** 2026-08-07
- **Project:** specd

## Context

GitLab support was the last unimplemented piece of the `VcsAdapter` interface
(`apps/api/src/vcs/vcs.types.ts`) — onboarding, indexing and the hosted build
station were already provider-agnostic against it; only a `GitLabAdapter`,
its webhook receiver, and the wiring in `vcs.service.ts`/`workspace.ts` were
missing. GitLab has no equivalent of a GitHub **App**: no installation
lifecycle, no account-level webhook, no short-lived per-run token minted from
a private key. Whatever auth story was chosen, self-managed instances need a
token regardless — an OAuth app would have to be registered separately on
every instance a customer runs.

## Decision

Connect a project with a **personal or project access token** (`api` scope),
for gitlab.com and self-managed alike, distinguished only by an optional
`instanceUrl` stored on the connection. This is the same trade-off a GitHub
PAT makes, and was GitHub's own path before the App existed
(`github.adapter.ts`'s own comment: "P1 uses a PAT or installation token
directly... the GitHub App install flow is P1-scope wiring on top of this
class, not a change to it"). A gitlab.com OAuth app narrowing this to a
button instead of a pasted token is possible future wiring on the same
adapter, not a rewrite of it.

Two consequences follow from having no App:

- **The webhook is registered per repository**, at add-time
  (`RepositoriesService.add` → `GitLabAdapter.registerWebhook`), not once for
  a whole installation. Registration needs at least the Maintainer role and
  can fail — that failure degrades the repository to local mode's existing
  fallback (the **"I merged it"** button, tracked via the new
  `repositories.webhook_status` column: `none | registered | failed`) rather
  than blocking the add.
- **Verification is a token comparison, not a signature.** GitLab does not
  sign the request body; a webhook carries a secret token instead, echoed
  back verbatim in `X-Gitlab-Token`. One `GITLAB_WEBHOOK_SECRET` is shared
  across every tenant's webhook (mirroring how one `GITHUB_WEBHOOK_SECRET`
  already is), compared in constant time, failing closed exactly as GitHub's
  does when unset.

Because one specd deployment can hold repositories on gitlab.com *and* one or
more self-managed instances at once, a numeric project id or namespaced path
alone is not a safe match — two different instances can each have their own
unrelated "project 7". `GitLabWebhookService.resolveRepo` therefore scopes
the match by instance: it compares the host of the payload's `project.web_url`
against the host of the matching repository's own connection
(`connections.settings.instanceUrl`), and treats a same-id-different-instance
row as no match at all, not an ambiguous one.

## Consequences

- A GitLab token lives in the vault for as long as the connection does and is
  used exactly as issued — there is no per-run minting to shrink its
  lifetime or scope the way an App installation token does. Recommending a
  **project** access token over a personal one (`docs/gitlab.md`) is the only
  mitigation available; rotation is the operator's responsibility.
- There is no browser connect flow yet — a project is connected with a curl
  call against the already-provider-agnostic
  `POST /projects/:slug/connections/vcs`, same as GitHub is today. Both are
  equally incomplete here; neither is a regression relative to the other.
- Hosted builds (station 05, mode a) work identically for GitLab and GitHub —
  `WorkspaceService.createGitLab` clones with a per-invocation git auth
  header, exactly as `createGitHub` does, and pushes to a branch plus an
  opened merge request, never the default branch.