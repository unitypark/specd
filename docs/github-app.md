# The specd GitHub App

specd talks to GitHub as an **App**, not as a user with a personal access token.
That distinction is the whole point: an App's credential is a private key that
mints repository-scoped tokens which expire within the hour, and it can only
reach the repositories someone explicitly granted it. A PAT carries the full
authority of whoever created it, forever, over everything they can see.

Local git mode needs none of this. Set it up when you want specd to work on
GitHub repositories.

---

## What it asks for, and why

| Permission | Why |
|---|---|
| `contents: write` | Push the setup branch and the spec branches |
| `pull_requests: write` | Open the PRs those branches are reviewed in |
| `metadata: read` | Mandatory for every GitHub App |

That is the complete list. No workflows, no packages, no organization
administration, no secrets. **specd never pushes to your default branch** — the
write path is branches and pull requests, so every change an agent makes stops
at a review you control. Merging is how it gets in.

Events it subscribes to:

| Event | What specd does with it |
|---|---|
| `pull_request` (merged) | Setup branch → mark adopted and index `knowledge/`. Spec branch → mark the spec delivered and re-index. |
| `push` to the default branch | Re-index if `knowledge/` changed. |

It also handles `installation` and `installation_repositories`, which track
revocation so a removed App stops working immediately. Those are **not**
subscribed to and must not appear in the manifest — GitHub delivers them to
every App automatically and rejects a manifest that lists them.

Everything else is recorded and ignored.

---

## Register it

### The one-click path

With the API running, open:

```
http://localhost:4000/api/github/app/register
```

Add `?org=your-org` to create it under an organization instead of your personal
account.

**GitHub will not accept a webhook URL it cannot reach.** If `API_PUBLIC_URL`
points at localhost or a private address, specd registers the App *without* a
webhook and says so on the page — branches and PRs work, merges are not
detected. To get webhooks from the start, set up a tunnel first (below), point
`API_PUBLIC_URL` at it, restart, and then register. You can also add the URL
later under the App's Settings → Webhook. The page hands GitHub a manifest with the permissions above and
redirects back with the credentials, which are shown **once**:

```
GITHUB_APP_ID=123456
GITHUB_APP_SLUG=specd
GITHUB_WEBHOOK_SECRET=…
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n…"
```

Put them in `.env` and restart the API. specd stores none of them — the private
key belongs in your deployment's secret store, and installation tokens are
minted per run and never written down.

### By hand

Use this if the manifest flow fails for any reason. It is the same App, typed
in rather than generated.

**1. Open the form.** <https://github.com/settings/apps/new>
(for an organization: `https://github.com/organizations/<org>/settings/apps/new`)

**2. Fill in the top section.**

| Field | Value |
|---|---|
| GitHub App name | `specd-<your-handle>` — it must be **globally unique**, so plain `specd` is likely taken |
| Homepage URL | `http://localhost:4000` — any URL is accepted here; it is only a link |
| Description | Optional |

**3. Webhook — this is the step that matters.**

- Running on localhost: **untick `Active`**. GitHub validates the URL and
  refuses anything it cannot reach, so leaving it ticked with a localhost URL
  is what makes the form fail. Local webhook delivery is handled separately
  (see *Webhooks in local development* below).
- Running somewhere public: leave `Active` ticked, set **Webhook URL** to
  `<your API>/api/github/webhook`, and set a **Webhook secret** to any long
  random string — the same value goes in `GITHUB_WEBHOOK_SECRET`. Generate one
  with `openssl rand -hex 32`.

**4. Permissions.** Under **Repository permissions** set exactly these two:

| Permission | Access |
|---|---|
| Contents | Read and write |
| Pull requests | Read and write |

`Metadata: Read-only` is selected for you and cannot be removed. Leave every
other permission at *No access* — organization and account permissions included.

**5. Subscribe to events.** If you ticked `Active`, select **Push** and
**Pull request**. If you unticked it, this section does nothing and can be
skipped. Do not look for `installation` or `installation_repositories` — they
are not listed, because every App receives them automatically.

**6. Where can this GitHub App be installed?** *Only on this account.*

**7. Click *Create GitHub App*.**

**8. Collect the credentials** from the App's **General** tab:

- **App ID** — a number near the top → `GITHUB_APP_ID`
- **App slug** — the last path segment of the page URL → `GITHUB_APP_SLUG`
- **Private key** — scroll to *Private keys* → *Generate a private key*. A
  `.pem` downloads. It is shown once.

**9. Put the key in `.env`.** It is multi-line, so it needs escaping:

```bash
# from the repo root, pointing at wherever the .pem landed
node -e 'const fs=require("fs");
  const pem=fs.readFileSync(process.argv[1],"utf8").trim();
  console.log(`GITHUB_APP_PRIVATE_KEY="${pem.replace(/\n/g,"\\n")}"`)' \
  ~/Downloads/*.private-key.pem
```

Paste the printed line into `.env`, then restart the API. It logs the App id at
boot, and `GET /api/github/status` confirms what it thinks it has.

### Install it

Visit `https://github.com/apps/<your-app-slug>/installations/new`, pick the
repositories, and note the installation id from the URL you land on
(`…/installations/<id>`). Then attach it to a project:

```bash
curl -X POST "$SPECD_API/github/projects/$PROJECT_ID/installation" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"installationId":"12345678"}'
```

The response lists exactly the repositories the installation was granted. That
list is the repo picker — specd cannot see anything outside it.

---

## Webhooks in local development

GitHub cannot reach `localhost`. Until the API has a public URL, forward the
deliveries. Pick whichever you already have:

```bash
# GitHub CLI (no account needed anywhere else)
gh webhook forward --repo=<owner>/<repo> --events=push,pull_request \
  --url=http://localhost:4000/api/github/webhook

# or a tunnel, and set the App's webhook URL to the public hostname
ngrok http 4000
cloudflared tunnel --url http://localhost:4000
```

Two things to know about the choice:

- `gh webhook forward` creates a **repository** webhook, not the App's. It
  re-signs deliveries with its own secret and prints it — put **that** value in
  `GITHUB_WEBHOOK_SECRET` while you are using it, or every delivery fails the
  signature check. You get `push` and `pull_request`, which is enough to
  exercise merge → re-index, but not installation events.
- A tunnel gives you the App's real deliveries, signed with the App's own
  secret. A quick tunnel's hostname changes on every restart, so the App's
  webhook URL has to be updated each time.

Without any of this, nothing breaks: merges simply are not detected, and the
"I merged it" button remains the way to record adoption.

### Checking it works

```bash
# What specd thinks it is configured for
curl -H "Authorization: Bearer $TOKEN" "$SPECD_API/github/status"

# The deliveries it has actually received for a project
curl -H "Authorization: Bearer $TOKEN" "$SPECD_API/github/projects/$PROJECT_ID/deliveries"
```

Every delivery is recorded with what specd decided and why — including the ones
it ignored. "The webhook arrived and specd chose not to act" and "the webhook
never arrived" are different problems, and this tells you which one you have.

---

## Environment

| Variable | Required | Notes |
|---|---|---|
| `GITHUB_APP_ID` | for GitHub mode | Numeric id from the App's settings page |
| `GITHUB_APP_PRIVATE_KEY` | for GitHub mode | The `.pem`, with real newlines or `\n` escapes |
| `GITHUB_WEBHOOK_SECRET` | for webhooks | **Without it every delivery is rejected** |
| `GITHUB_APP_SLUG` | no | Defaults to `specd`; used to build the install URL |
| `API_PUBLIC_URL` | for webhooks | Where GitHub should send deliveries |
| `SPECD_BUILD_ROOT` | no | Scratch root for build clones; defaults to the system temp dir |
| `GITHUB_API_BASE`, `GITHUB_BASE`, `GITHUB_CLONE_BASE` | GHES only | Point these at your GitHub Enterprise host |

The API logs which of these it is missing at boot rather than failing at the
first webhook.

---

## Security notes

**The webhook endpoint is unauthenticated by necessity** — GitHub has no specd
session. Its signature check is therefore the only thing between a stranger and
"this PR merged, go re-index and mark that spec delivered". So:

- Every delivery is verified with HMAC-SHA256 over the raw request bytes,
  compared in constant time, before the payload is parsed.
- **An unset `GITHUB_WEBHOOK_SECRET` rejects everything.** It never means
  "skip the check" — a forgotten variable must not become an open write
  endpoint.
- Deliveries are deduplicated by GitHub's delivery id, so a retry or a manual
  redelivery cannot re-run an index or double-record a merge.
- An event is acted on only if its repository *and* its installation match a
  registered project. Anything else is logged and dropped, never guessed at.

**Tokens.** Installation tokens are minted per run, cached in memory only until
shortly before they expire, and never persisted. Build clones authenticate with
a per-invocation git header rather than writing the credential into
`.git/config`, so no live credential is left on disk. Uninstalling or suspending
the App marks the connection revoked and drops the cached token immediately.

**What specd can still do that you should know about.** Within the repositories
you grant, it can push branches and open PRs at any time a run is triggered. It
cannot merge them, cannot push to your default branch, and cannot see any
repository you did not grant.
