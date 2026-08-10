# Jira Cloud

**Status: working, and connectable from the setup wizard.** Pick *Jira Cloud*
at step 4, paste a site URL, an account email and an API token, choose a
project, and optionally import its open issues. Issue import, backlink
comments and status mirroring all work.

The `curl` calls below are the same thing without the browser — useful for
scripting, and for adding a status map, which the wizard does not yet expose.

**Cloud only.** Jira Server/Data Center uses a different base path and
different auth, and is out of scope rather than half-supported.

---

## Connect a project

You need an **API token**, not an OAuth app. Create one at
[id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens)
→ Security → API tokens. Why a token rather than 3LO:
`knowledge/decisions/0010-jira-via-api-token-and-a-mirror-that-cannot-fail.md`.

```bash
curl -X PATCH "$SPECD_API/projects/aurora-crm/connections/tracker" \
  -H "Authorization: Bearer $SPECD_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "provider": "jira",
    "siteUrl": "https://your-team.atlassian.net",
    "email": "you@your-team.com",
    "apiToken": "'"$JIRA_API_TOKEN"'",
    "projectKey": "AUR"
  }'
```

The token is verified against `/myself` before anything is stored, so a bad
credential fails here — in front of you — rather than later inside a spec run.
The response names the account it authenticated as. The token is then held
with the same envelope encryption as every other credential, bound to this
project, and never logged.

List what the credential can see:

```bash
curl "$SPECD_API/projects/aurora-crm/tracker/jira/projects" \
  -H "Authorization: Bearer $SPECD_TOKEN"
```

## Import issues

```bash
# Look first — nothing is written.
curl "$SPECD_API/projects/aurora-crm/tracker/jira/issues" \
  -H "Authorization: Bearer $SPECD_TOKEN"

# Then import.
curl -X POST "$SPECD_API/projects/aurora-crm/tracker/jira/import" \
  -H "Authorization: Bearer $SPECD_TOKEN" \
  -H 'Content-Type: application/json' -d '{"limit": 50}'
```

Only open issues are imported — `statusCategory != Done`, newest first.
Importing a closed backlog would fill the board with work nobody is going to
spec.

An imported ticket **keeps its Jira key**, so `specd spec pull AUR-142` reads
the same whether the work came from Jira or was written in specd. Re-importing
updates title and body rather than creating a second copy, and leaves the
board column exactly where your team dragged it.

## What specd writes back

Two things, both triggered by a spec changing state, both **best-effort**:

- **A comment**, linking to the spec in specd, saying what just happened. The
  approval comment says a *person* approved it, because that is the
  distinction the product exists to make.
- **A status transition**, if you mapped one.

### Status mapping

Optional, and empty by default — specd does not guess what your "Done" is
called. Map specd's lifecycle states to your Jira **status names**:

```bash
curl -X PATCH "$SPECD_API/projects/aurora-crm/connections/tracker" \
  -H "Authorization: Bearer $SPECD_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "provider": "jira",
    "siteUrl": "https://your-team.atlassian.net",
    "email": "you@your-team.com",
    "apiToken": "'"$JIRA_API_TOKEN"'",
    "projectKey": "AUR",
    "statusMap": { "approved": "In Progress", "delivered": "Done" }
  }'
```

Lifecycle states you can map: `draft`, `in_review`, `changes_requested`,
`approved`, `building`, `delivered`, `blocked`. An unmapped state is simply
not mirrored; the comment still happens.

Names are resolved against the transitions Jira actually offers for that issue
*at that moment*, matching the destination status first and the transition's
own label second. If your workflow has no route there from where the issue
currently sits, specd logs it and leaves the issue alone — Jira workflows have
guards, and a spec being approved does not oblige the issue to be movable.

## The rule worth knowing

**Nothing Jira does can fail a specd action.** Approving a spec succeeds
whether or not Jira is reachable. The spec lifecycle is specd's own state and
the human gate is specd's own guarantee — making either depend on a
third-party API being up would mean an Atlassian incident could stop your team
approving their own work, and a timeout could leave the two systems
disagreeing about whether an approval happened.

So every write to Jira is attempted, and its failure is logged rather than
raised. Local state is authoritative; Jira is a projection of it.

## What is not built yet

- **A status-map editor.** The wizard connects Jira and picks a project, but
  the lifecycle → status map is set with the `PATCH` above.
- **Inbound webhooks.** specd writes to Jira but does not listen: moving an
  issue in Jira does not move the spec. Registering a Jira webhook needs site
  admin, so this needs a polling fallback as well — neither is built.
- **Field mapping beyond status.** Deliberate. §11 of the plan: *"Field
  mapping UI is where Jira integrations go to die."*
- **Jira Server/Data Center.**

## Verification status, stated plainly

The adapter is tested against the documented REST contract with a stubbed
transport — request shapes, the Basic auth header, ADF comment bodies,
transition resolution, error unwrapping, and the best-effort guarantee are all
covered. **It has not been run against a live Atlassian site.** The `/myself`
check at connect time is what proves the transport end-to-end the first time
a real credential is pasted, which is why it is there.
