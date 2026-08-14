import type { DocCategory } from './types';

/*
 * Integrations — one page per external system specd talks to.
 *
 * These pages are the reader-facing version of docs/github-app.md,
 * docs/gitlab.md, docs/jira.md and docs/runners.md in the repository, and
 * they say the same things: same permissions, same failure rules, same list
 * of what is not built. Where a walkthrough gets long (registering an App by
 * hand, every curl call) the page links to the file rather than duplicating
 * a procedure that would then drift.
 */
export const INTEGRATIONS: DocCategory = {
  title: 'Integrations',
  blurb: 'GitHub, GitLab, Jira and your own machines.',
  pages: [
    {
      slug: 'github',
      title: 'GitHub',
      summary:
        'specd connects as a GitHub App with three permissions and hour-long tokens — how to register it, what it listens to, and how to test webhooks locally.',
      audience: 'engineering',
      minutes: 7,
      blocks: [
        {
          k: 'lead',
          text: 'specd talks to GitHub as an **App**, not as a user with a personal access token. An App\'s credential mints repository-scoped tokens that expire within the hour and can only reach repositories someone explicitly granted. A PAT carries the full authority of whoever created it, forever, over everything they can see.',
        },
        { k: 'h2', text: 'What it asks for' },
        {
          k: 'table',
          head: ['Permission', 'Why'],
          rows: [
            ['`contents: write`', 'Push the setup branch and the spec branches.'],
            ['`pull_requests: write`', 'Open the pull requests those branches are reviewed in.'],
            ['`metadata: read`', 'Mandatory for every GitHub App.'],
          ],
        },
        {
          k: 'p',
          text: 'That is the complete list. No workflows, no packages, no organisation administration, no secrets.',
        },
        {
          k: 'note',
          tone: 'rule',
          title: 'specd never pushes to your default branch',
          text: 'The write path is branches and pull requests, so every change an agent makes stops at a review you control. Merging is how it gets in.',
        },
        { k: 'h2', text: 'What it listens to' },
        {
          k: 'table',
          head: ['Event', 'What specd does with it'],
          rows: [
            [
              '`pull_request` (merged)',
              'Setup branch → mark adopted and index `knowledge/`. Spec branch → mark the spec delivered and re-index.',
            ],
            ['`push` to the default branch', 'Re-index if `knowledge/` changed.'],
          ],
        },
        {
          k: 'p',
          text: 'It also handles `installation` and `installation_repositories` to track revocation, so a removed App stops working immediately. Everything else is recorded and ignored.',
        },
        { k: 'h2', text: 'Register it' },
        {
          k: 'p',
          text: 'With the API running, the one-click path uses GitHub\'s manifest flow — you approve, GitHub creates the App, and specd stores the credentials:',
        },
        {
          k: 'code',
          caption: 'terminal',
          code: `open http://localhost:4000/api/github/app/register`,
        },
        {
          k: 'p',
          text: 'The by-hand path, and installing the App onto specific repositories, are written out step by step in `docs/github-app.md` in the repository.',
        },
        { k: 'h2', text: 'Webhooks in local development' },
        {
          k: 'p',
          text: 'GitHub cannot reach `localhost`. Until the API has a public URL, forward the deliveries with whichever you already have:',
        },
        {
          k: 'code',
          caption: 'terminal',
          code: `# GitHub CLI
gh webhook forward --repo=<owner>/<repo> --events=push,pull_request \\
  --url=http://localhost:4000/api/github/webhook

# or a tunnel, with the App's webhook URL set to the public hostname
ngrok http 4000
cloudflared tunnel --url http://localhost:4000`,
        },
        {
          k: 'note',
          tone: 'warn',
          title: '`gh webhook forward` re-signs with its own secret',
          text: 'It creates a **repository** webhook, not the App\'s, and prints a secret of its own — put that value in `GITHUB_WEBHOOK_SECRET` while you use it, or every delivery fails the signature check. A tunnel gives you the App\'s real deliveries instead, at the cost of a hostname that changes on every restart.',
        },
        {
          k: 'p',
          text: 'Without either, nothing breaks: merges are simply not detected, and the "I merged it" button remains the way to record adoption.',
        },
        { k: 'h2', text: 'Checking it works' },
        {
          k: 'code',
          caption: 'terminal',
          code: `# what specd thinks it is configured for
curl -H "Authorization: Bearer $TOKEN" "$SPECD_API/github/status"

# the deliveries it has actually received for a project
curl -H "Authorization: Bearer $TOKEN" \\
  "$SPECD_API/github/projects/$PROJECT_ID/deliveries"`,
        },
        {
          k: 'p',
          text: 'Every delivery is recorded with what specd decided and why — including the ones it ignored. "The webhook arrived and specd chose not to act" and "the webhook never arrived" are different problems, and this tells you which one you have.',
        },
        { k: 'h2', text: 'How deliveries are trusted' },
        {
          k: 'ul',
          items: [
            'HMAC-verified over the **raw bytes**, in constant time, **before parsing**. A signature checked after parsing has already run a parser on unauthenticated input.',
            'An **unset secret rejects everything** rather than waving it through. Fail-closed is the only safe default for a webhook endpoint.',
            'Deliveries are deduped by delivery id, and specd acts only for a registered repository.',
          ],
        },
      ],
    },

    {
      slug: 'gitlab',
      title: 'GitLab',
      summary:
        'gitlab.com and self-managed, connected with an `api`-scoped access token — same write path, same fail-closed webhook rule.',
      audience: 'engineering',
      minutes: 5,
      blocks: [
        {
          k: 'lead',
          text: 'GitLab has no App-installation concept, so a connection is a token — plus the instance URL for self-managed. specd is explicit about the trade-off that makes rather than hiding it.',
        },
        { k: 'h2', text: 'What it needs' },
        {
          k: 'table',
          head: ['Scope', 'Why'],
          rows: [
            [
              '`api` (personal or project access token)',
              'Read repository contents, push branches, open merge requests, register a webhook.',
            ],
          ],
        },
        {
          k: 'note',
          tone: 'warn',
          title: 'The trade-off, stated',
          text: 'A token is long-lived and as broadly scoped as whoever issued it, for as long as it is valid. A gitlab.com OAuth app narrowing that is possible future wiring on top of this, not a change to it — and self-managed instances need a token regardless, since an OAuth app would have to be registered separately on every instance.',
        },
        { k: 'h2', text: 'What it listens to' },
        {
          k: 'table',
          head: ['Event', 'What specd does with it'],
          rows: [
            [
              'Merge request merged',
              'Setup branch → mark adopted and index `knowledge/`. Spec branch → mark the spec delivered and re-index.',
            ],
            ['Push to the default branch', 'Re-index if `knowledge/` changed.'],
          ],
        },
        {
          k: 'p',
          text: 'There is no installation lifecycle to track: a token is valid until revoked or expired, and GitLab sends no webhook for that. A build or index that starts failing with 401s is the signal — reconnect with a fresh token.',
        },
        { k: 'h2', text: 'Connect a project' },
        {
          k: 'p',
          text: 'There is no browser flow yet; connect over the API. Create the token under **Edit profile → Access Tokens**, or a **project** access token under the project\'s **Settings → Access Tokens**. Grant the `api` scope and at least the **Maintainer** role — anything less can read and propose changes but cannot register the webhook.',
        },
        {
          k: 'code',
          caption: 'terminal',
          code: `curl -X POST "$SPECD_API/projects/$PROJECT_SLUG/connections/vcs" \\
  -H "Authorization: Bearer $TOKEN" \\
  -H 'Content-Type: application/json' \\
  -d '{ "provider": "gitlab", "accessToken": "'"$GITLAB_TOKEN"'" }'`,
        },
        {
          k: 'p',
          text: 'The complete walkthrough — self-managed instance URLs, webhook registration, verification — is in `docs/gitlab.md` in the repository.',
        },
        { k: 'h2', text: 'Webhook trust' },
        {
          k: 'p',
          text: 'GitLab offers a token echo rather than an HMAC signature, so specd uses that, compared in constant time. The rule is identical to GitHub\'s: an **unset secret rejects everything**, deliveries are deduped, and specd acts only for a registered repository.',
        },
      ],
    },

    {
      slug: 'jira',
      title: 'Jira',
      summary:
        'Import issues, backlink comments and mirror status — one-way, and unable to fail a specd action.',
      audience: 'everyone',
      minutes: 6,
      blocks: [
        {
          k: 'lead',
          text: 'Jira stays Jira. specd links to the issue and mirrors its own lifecycle back onto it, and nothing Jira does can block your team from approving their own work.',
        },
        {
          k: 'note',
          tone: 'info',
          title: 'Jira Cloud only',
          text: 'Server and Data Center use a different base path and different auth, and are out of scope rather than half-supported.',
        },
        { k: 'h2', text: 'Connecting' },
        {
          k: 'p',
          text: 'Pick **Jira Cloud** at step 4 of the setup wizard, paste a site URL, an account email and an **API token**, choose a project, and optionally import its open issues. Create the token at [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens) → Security → API tokens.',
        },
        {
          k: 'p',
          text: 'The token is verified against `/myself` **before anything is stored**, so a bad credential fails in front of you rather than later inside a spec run. It is then held with the same envelope encryption as every other credential, bound to this project, and never logged.',
        },
        { k: 'h2', text: 'What specd writes back' },
        {
          k: 'ul',
          items: [
            'A **backlink comment** on the issue when a spec is created for it.',
            'A **status transition**, if you have configured a status map.',
          ],
        },
        { k: 'h3', text: 'Status mapping' },
        {
          k: 'p',
          text: 'Optional, and empty by default — specd does not guess what your "Done" is called. The lifecycle states you can map are `draft`, `in_review`, `changes_requested`, `approved`, `building`, `delivered` and `blocked`. An unmapped state is simply not mirrored; the comment still happens.',
        },
        {
          k: 'code',
          caption: 'terminal — the wizard does not expose this yet',
          code: `curl -X PATCH "$SPECD_API/projects/$SLUG/connections/tracker" \\
  -H "Authorization: Bearer $SPECD_TOKEN" \\
  -H 'Content-Type: application/json' \\
  -d '{
    "provider": "jira",
    "siteUrl": "https://your-team.atlassian.net",
    "email": "you@your-team.com",
    "apiToken": "'"$JIRA_API_TOKEN"'",
    "projectKey": "AUR",
    "statusMap": { "approved": "In Progress", "delivered": "Done" }
  }'`,
        },
        {
          k: 'p',
          text: 'Names are resolved against the transitions Jira actually offers for that issue _at that moment_, matching the destination status first and the transition\'s own label second. If your workflow has no route there from where the issue currently sits, specd logs it and leaves the issue alone — Jira workflows have guards, and a spec being approved does not oblige an issue to be movable.',
        },
        { k: 'h2', text: 'The rule worth knowing' },
        {
          k: 'note',
          tone: 'rule',
          title: 'Nothing Jira does can fail a specd action',
          text: 'Approving a spec succeeds whether or not Jira is reachable. Making the human gate depend on a third-party API being up would mean an Atlassian incident could stop your team approving their own work, and a timeout could leave the two systems disagreeing about whether an approval happened. Every write to Jira is attempted and its failure logged, never raised. Local state is authoritative; Jira is a projection of it.',
        },
        { k: 'h2', text: 'What is not built yet' },
        {
          k: 'ul',
          items: [
            '**A status-map editor.** The wizard connects Jira and picks a project; the map is set with the `PATCH` above.',
            '**Inbound sync.** specd writes to Jira but does not listen — moving an issue in Jira does not move the spec. Registering a Jira webhook needs site admin, so this needs a polling fallback as well; neither is built.',
            '**Field mapping beyond status.** Deliberate, not pending.',
            '**Jira Server / Data Center.**',
          ],
        },
      ],
    },

    {
      slug: 'self-hosted-runners',
      title: 'Self-hosted runners',
      summary:
        'Pair a machine to run spec, onboard and build jobs with its own Claude Code and its own git credentials.',
      audience: 'engineering',
      minutes: 8,
      blocks: [
        {
          k: 'lead',
          text: 'A runner is a machine of yours that claims jobs and executes them locally. It exists so the model credential and the git credential can both be _yours_, on hardware you control, while specd still orchestrates the pipeline.',
        },
        { k: 'h2', text: 'Pair a machine' },
        {
          k: 'steps',
          items: [
            {
              title: 'Generate a pairing code',
              text: 'From the project\'s Settings page (owner or maintainer). It is shown once — copy it now.',
            },
            {
              title: 'Run the pair command on the machine',
              text: '`specd runner pair 5VXCK-7UYZC`. The code is single-use and expires after 30 minutes if never redeemed, the same way an unused device-login code does.',
            },
            {
              title: 'Read all three lines it prints',
              text: 'It reports the project it paired with, that the token was stored, and that outbound connectivity to the API works — so a firewall rule is caught right there rather than discovered later on a job that silently never starts.',
            },
          ],
        },
        {
          k: 'note',
          tone: 'good',
          title: 'A runner token never overwrites a person\'s session',
          text: 'The token is stored in the OS keychain on macOS, or a `0600` file under the config directory elsewhere — in a **separate slot** from a signed-in user\'s own CLI token. Pairing a runner on a machine you are also `specd login`-ed on is safe.',
        },
        { k: 'h2', text: 'Run the daemon' },
        {
          k: 'code',
          caption: 'terminal',
          code: `SPECD_RUNNER_TOKEN=$(specd runner token) SPECD_API=http://localhost:4000/api \\
  pnpm --filter @specd/runner start`,
        },
        {
          k: 'p',
          text: 'It polls for claimable work on an interval (`SPECD_RUNNER_POLL_MS`, default 5s). When a `spec` or `onboard` job is queued for its project, it drives the machine\'s own local `claude` CLI and reports the parsed result back.',
        },
        {
          k: 'p',
          text: 'It **never touches the database or the knowledge index** — the server does all of that on either side of the daemon\'s one job: drive the model, hand back a parsed reply. `build` jobs are the exception that also needs `git` on PATH.',
        },
        { k: 'h2', text: 'Builds use the runner\'s own git' },
        {
          k: 'note',
          tone: 'rule',
          title: 'specd sends no VCS token to a runner',
          text: 'A dispatched build clones and pushes with **the runner machine\'s own git credentials** — the ones already configured for the human who owns it. Push access is checked _before the first model call_, rather than discovered at the end of an expensive run.',
        },
        { k: 'h2', text: 'Leases and reclaim' },
        {
          k: 'p',
          text: 'A claimed job is held under a lease. If the runner stops heartbeating, the job becomes claimable again — after **180s** for most jobs, **900s** for builds, because a build legitimately takes longer to look alive.',
        },
        {
          k: 'p',
          text: 'After **three** reclaims the job is failed as _repeatedly abandoned_ rather than bouncing between runners forever. A job that cannot be executed anywhere is a job someone needs to look at, and a queue that hides that is a queue that quietly stalls.',
        },
        { k: 'h2', text: 'Managing runners' },
        {
          k: 'p',
          text: 'Project Settings lists every runner — paired or awaiting its first pairing, and how long since it was last heard from. Removing one revokes it immediately: its stored token stops authenticating on the very next request, with no grace period.',
        },
        { k: 'h2', text: 'When a runner is used' },
        {
          k: 'p',
          text: 'Automatically, whenever a project\'s AI mode is `subscription_runner` and a runner is paired to it. If no runner is available, nothing is dispatched — the synchronous path (specd\'s own process shelling out to a local `claude`) runs exactly as before.',
        },
        {
          k: 'note',
          tone: 'warn',
          title: 'One job at a time, for now',
          text: 'Runner concurrency is not built. A machine executes a single job and polls again when it is done.',
        },
        {
          k: 'p',
          text: 'The complete reference — every environment variable, the job lifecycle, the build sandbox — is in `docs/runners.md` in the repository.',
        },
      ],
    },
  ],
};
