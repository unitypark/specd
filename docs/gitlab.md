# GitLab

specd talks to GitLab with a **personal or project access token**
(`api` scope), not an App. GitLab has no App-installation concept the way
GitHub does, so there is nothing to register at the account level — a
connection is just a token, and for self-managed instances, the instance URL.
The trade-off is the one every PAT makes: the token is long-lived and as
broadly scoped as whoever issued it, for as long as it is valid. A gitlab.com
OAuth app narrowing that is possible future wiring on top of this, not a
change to it — and self-managed instances need a token regardless, since an
OAuth app would have to be registered separately on every instance.

Local git mode needs none of this. Set this up when you want specd to work on
GitLab repositories, gitlab.com or self-managed.

---

## What it needs, and why

| Scope | Why |
|---|---|
| `api` (personal or project access token) | Read repository contents, push branches, open merge requests, register a webhook |

That is the whole list. **specd never pushes to your default branch** — the
write path is branches and merge requests, so every change an agent makes
stops at a review you control. Merging is how it gets in, exactly as it is
for GitHub.

Events it subscribes to, per repository:

| Event | What specd does with it |
|---|---|
| Merge request merged | Setup branch → mark adopted and index `knowledge/`. Spec branch → mark the spec delivered and re-index. |
| Push to the default branch | Re-index if `knowledge/` changed. |

Unlike GitHub there is no installation lifecycle to track — a token is valid
until it is revoked or expires, and GitLab sends no webhook for that. A build
or index that starts failing with 401s is the signal; reconnect with a fresh
token.

---

## Connect a project

There is no browser flow yet — connect with the API directly. (The wizard's
GitLab card is clickable but not wired to this; see the note on the card
itself, and the web UI issue this leaves is intentionally visible rather than
hidden.)

**1. Create a token.** On gitlab.com or your self-managed instance: **Edit
profile → Access Tokens** (or a **project** access token under the project's
**Settings → Access Tokens**, which is scoped to just that project). Grant the
`api` scope and at least the **Maintainer** role — anything less can read and
propose changes but cannot register the webhook in step 3.

**2. Store the connection.**

```bash
curl -X POST "$SPECD_API/projects/$PROJECT_SLUG/connections/vcs" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
        "provider": "gitlab",
        "token": "glpat-xxxxxxxxxxxxxxxxxxxx"
      }'
```

Self-managed instance: add `"instanceUrl": "https://gitlab.example.com"`.
Omit it for gitlab.com. A bare host (`gitlab.example.com`) is accepted and
read as https; anything specd cannot turn into an http(s) origin is refused
here, on this call, rather than at the repository listing one call later.

### When a self-managed instance does not connect

specd reaches your instance **from the machine specd runs on**, not from your
browser — so the checks are about that machine. Every one of these now comes
back as a sentence naming the cause, rather than as "Internal server error":

| What you see | What it means |
| --- | --- |
| `does not resolve from the machine specd runs on` | Wrong hostname, or this machine is not on the VPN that can see it. |
| `refused the connection` | The host resolves; the port is wrong, or nothing is serving there. |
| `did not answer in time` | Typically a firewall, or a VPN that is not connected. |
| `presented a certificate this machine does not trust` | An internal CA. Point `NODE_EXTRA_CA_CERTS` at it where specd runs — do not disable verification. |
| `→ 401` | The instance answered. The token is the problem, not the network. |

**3. Find and add a repository.** The picker reads live from the token —
specd cannot see anything it was not granted:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "$SPECD_API/gitlab/projects/$PROJECT_ID/repositories?search=aurora"
```

Then register the one you want, the same call every provider uses:

```bash
curl -X POST "$SPECD_API/projects/$PROJECT_SLUG/repositories" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
        "provider": "gitlab",
        "name": "acme-group/aurora-api",
        "externalId": "42200011",
        "defaultBranch": "main",
        "isPrimary": true
      }'
```

`name` is the namespaced path (`group/project`, or `group/subgroup/project`);
`externalId` is the numeric project id the picker returned. Adding a GitLab
repository registers its webhook automatically — the response's
`webhookStatus` says whether that succeeded (`registered`) or not (`failed`,
most often a token below Maintainer, or `GITLAB_WEBHOOK_SECRET` unset).

---

## Webhooks in local development

GitLab cannot reach `localhost` either. Point `API_PUBLIC_URL` at a tunnel
before adding the repository, since registration happens at that moment:

```bash
ngrok http 4000
# or: cloudflared tunnel --url http://localhost:4000
```

A quick tunnel's hostname changes on every restart, and the webhook URL is
fixed at registration time — re-add the repository (or edit the webhook by
hand under the project's **Settings → Webhooks** in GitLab) after restarting
the tunnel.

Without any of this, nothing breaks: merges simply are not detected, and the
**"I merged it"** button in the repository list is the way to record adoption
— the same fallback local mode already uses.

### Checking it works

```bash
# Is a webhook secret configured at all?
curl -H "Authorization: Bearer $TOKEN" "$SPECD_API/gitlab/status"

# The deliveries actually received for a project
curl -H "Authorization: Bearer $TOKEN" "$SPECD_API/gitlab/projects/$PROJECT_ID/deliveries"
```

Every delivery is recorded with what specd decided and why — including the
ones it ignored, exactly as GitHub's are.

---

## Environment

| Variable | Required | Notes |
|---|---|---|
| `GITLAB_WEBHOOK_SECRET` | for webhooks | **Without it every delivery is rejected, and repositories cannot register a webhook at all.** |
| `SPECD_BUILD_ROOT` | no | Scratch root for build clones; defaults to the system temp dir |

There is no `GITLAB_API_BASE` — the instance URL lives on the connection
(`instanceUrl`), since one specd deployment can have projects on gitlab.com
*and* a self-managed instance at once.

---

## Security notes

**Verification here is a token comparison, not a signature.** GitLab does not
sign the request body the way GitHub's HMAC does — a webhook is created with a
secret token, and GitLab echoes it back verbatim in `X-Gitlab-Token` on every
delivery. specd compares it to `GITLAB_WEBHOOK_SECRET` in constant time before
looking at the payload at all. This is a real, if smaller, sharp edge: the
token is the entire trust boundary, with nothing tying it to the specific
bytes of a given request. **An unset `GITLAB_WEBHOOK_SECRET` rejects
everything** — same rule as GitHub's secret, for the same reason: "unset" must
never mean "skip the check".

**Deliveries are deduplicated by `X-Gitlab-Event-UUID`**, GitLab's per-delivery
id, so a retry cannot re-run an index or double-record a merge.

**An event is acted on only if its GitLab project id matches a registered
repository** — falling back to the namespaced path only for repositories added
without going through the picker (which is how the id gets stored). This is
what stops a same-named project on a different instance, or another
customer's project entirely, from driving your specs.

**Tokens.** Whatever role you grant the token, specd exercises exactly what
the API allows it and no more — it cannot merge a request, cannot push to
your default branch, and cannot see any project you did not grant it. Unlike
GitHub's per-run installation tokens, a GitLab PAT lives in the vault for as
long as the connection does; treat rotating it as routine maintenance, and
narrow it to a **project** access token instead of a personal one wherever
the workflow allows — the blast radius of a leaked project token is one
project, not everything you can see.
