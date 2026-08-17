# Runbook — running specd on specd

Per [`decisions/0011-specd-develops-specd.md`](../decisions/0011-specd-develops-specd.md),
changes to this repository enter as specd tickets and leave as approved specs.
This is how to get a working loop pointed at this repo.

You need a locally logged-in **Claude Code** (`claude --version` should answer).
Spec drafting runs through it in subscription mode — specd never sees that
credential (D2), which also means a contributor without one can read and
approve specs but not draft them.

## One-time setup

```bash
pnpm infra:up && pnpm db:migrate
pnpm dev                      # API on :4000, web on :3000
```

Then, in the web app: create a project, and at step 2 choose **Local** with
this repository's absolute path. At step 3 choose **your Claude subscription**.
At step 4 the built-in board is fine.

Skip the knowledge-init step — **this repo already has a `knowledge/` tree**.
Onboarding would draft one over the top of documents that were written by
hand. Index the existing one instead:

```bash
curl -X POST "$SPECD_API/projects/$SLUG/reindex" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"repositoryIds\":[\"$REPO_ID\"]}"
```

That is the one place this differs from onboarding a fresh repo, and it
matters: the point of running specd here is that the knowledge base is real.

## Per change

1. **Write the ticket on the board.** Describe the problem and the constraints,
   not the solution — the design is the spec's job. Say what is out of scope;
   the drafts respect it.
2. **Generate the spec**, review it, and comment. Re-running produces v2 with
   the discussion as input; v1 stays exactly as it was.
3. **A person approves it.** Not an agent, ever — the server refuses
   (`409 spec_not_approved`) and no client can route around that.
4. **Implement**, on `spec/<ID>-<slug>`, with a PR titled `[<ID>] - <Title>`.
   Either hand the spec to your own agent with `specd spec pull <id>`, or use
   the Build station.
5. **File the as-built spec** — the last task of every spec, into
   `knowledge/specs/`. It re-indexes on merge, which is what makes the next
   spec better than this one.

## What good drafting input looks like

The first real run (S-101) produced 10 cited claims out of 13 because the
ticket named the constraint that mattered ("the existing atomic-claim
guarantee must survive") and the excluded ground ("out of scope: per-runner
concurrency"). Vague tickets produce vague specs with more `UNVERIFIED`
markers — which is the system working, but it wastes a drafting run.

Treat `UNVERIFIED` markers as the review agenda. They are the claims the agent
could not ground in `knowledge/`, and they are usually the decisions a person
actually needs to make.
