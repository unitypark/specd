import type { DocCategory } from './types';

/*
 * Core concepts — the five ideas the rest of the product is a consequence of.
 * Each page answers one question and is readable without the others, at the
 * cost of a little repetition between them. That trade is deliberate: a
 * concept page nobody can enter from a search result is a concept page nobody
 * reads.
 */
export const CONCEPTS: DocCategory = {
  title: 'Core concepts',
  blurb: 'The five ideas everything else in specd follows from.',
  pages: [
    {
      slug: 'the-pipeline',
      title: 'The six stations',
      summary:
        'Connect, Ground, Spec, the human gate, Build, Learn — what each one does, and why the line cannot be reconfigured.',
      audience: 'everyone',
      minutes: 9,
      blocks: [
        {
          k: 'lead',
          text: 'Every specd project runs the same six stations in the same order. This is the opposite of a workflow builder, and the constraint is the feature: there is nothing to assemble, and nothing to mis-wire.',
        },
        {
          k: 'code',
          caption: 'fixed for every project',
          code: `Connect → Ground → Spec → [HUMAN] → Build → Learn
   01       02       03      04       05      06
                                              └──→ feeds 02`,
        },
        {
          k: 'p',
          text: 'Only station 01 takes configuration — which repositories, which model, which tracker. Stations cannot be added, skipped or removed, and the gate at 04 is structural rather than a setting someone can turn off.',
        },
        { k: 'h2', text: '01 · Connect' },
        {
          k: 'p',
          text: 'You point specd at the things it will work with: one or more **repositories**, a **model credential**, and optionally a **tracker**. Repositories can be a local path, a GitHub App installation or a GitLab access token. Nothing is copied — specd records _which_ repository, and reads it when it needs to.',
        },
        {
          k: 'p',
          text: 'Details: [Connect a repository](/docs/connect-a-repository), [Bring your own model](/docs/bring-your-own-model), [Jira](/docs/jira).',
        },
        { k: 'h2', text: '02 · Ground' },
        {
          k: 'p',
          text: 'A read-only scan of the repository produces your first knowledge base, delivered as a **setup pull request** carrying `AGENTS.md` and a `knowledge/` tree. Tables of commands, pipelines, services, configuration and entities are quoted from the files they name. The judgement around them is drafted for you to correct, and anything the scan could not ground says `UNVERIFIED`.',
        },
        {
          k: 'note',
          tone: 'rule',
          title: 'Onboarding reads the repository before it drafts',
          text: 'The wizard does not ask you to describe your architecture and then repeat it back. It reads manifests, CI workflows, compose files, `.env.example`, schemas and the workspace layout first. A generated knowledge base that was really a questionnaire would be a knowledge base nobody trusts.',
        },
        {
          k: 'p',
          text: 'Merging that pull request **is** adoption. specd indexes `knowledge/` the moment the webhook lands. Details: [Ground your repository](/docs/ground-your-repository).',
        },
        { k: 'h2', text: '03 · Spec' },
        {
          k: 'p',
          text: 'A ticket becomes a draft spec. The SpecAgent retrieves from your knowledge base — not from the model\'s memory of open-source code — and writes requirements, a cited design, and tasks. Every design claim is either cited or flagged. Details: [Specs and citations](/docs/specs-and-citations).',
        },
        { k: 'h2', text: '04 · The human gate' },
        {
          k: 'p',
          text: 'A named person approves a specific version. This is the station that makes the other five safe, and it is enforced in three independent places — the state machine, the API boundary and a database CHECK constraint. Details: [The human gate](/docs/the-human-gate).',
        },
        {
          k: 'quote',
          text: 'No agent may approve its own input, and the server refuses an unapproved spec no matter who asks.',
        },
        { k: 'h2', text: '05 · Build' },
        {
          k: 'p',
          text: 'The build agent implements the tasks in order, one commit each, on the spec\'s own `spec/<ID>-<slug>` branch, and opens a pull request titled `[<ID>] - <Title>`. It gets editing tools only — never a shell — and it never touches your working tree or pushes to a default branch. Details: [Build and ship](/docs/build-and-ship).',
        },
        { k: 'h2', text: '06 · Learn' },
        {
          k: 'p',
          text: 'You merge. The webhook fires, the as-built spec is filed into `knowledge/specs/`, the index refreshes, and station 02\'s corpus is one delivered spec richer. Details: [The learning loop](/docs/learning-loop).',
        },
        { k: 'h2', text: 'Why the line is fixed' },
        {
          k: 'p',
          text: 'A configurable pipeline is a pipeline where the gate is a step someone can remove under deadline pressure. Three things follow from making the line structural:',
        },
        {
          k: 'ul',
          items: [
            '**Nothing can be mis-wired.** There is no state where Build runs before an approval exists, because there is no way to express that state.',
            '**The gate cannot be optimised away.** It is not a setting, a policy or a lint rule — it is the shape of the system.',
            '**Every project is legible to everyone.** A reviewer moving between projects reads the same six stations, not somebody\'s bespoke graph.',
          ],
        },
        {
          k: 'p',
          text: 'The cost is real: if your process genuinely needs a seventh station, specd will not give you one. That trade is recorded as a decision in this repository\'s own knowledge base, at `knowledge/decisions/0001-adopt-spec-driven.md`.',
        },
        { k: 'h2', text: 'What runs where' },
        {
          k: 'table',
          head: ['Station', 'Who does the work', 'Needs a model?'],
          rows: [
            ['01 Connect', 'You, in the wizard', 'No'],
            ['02 Ground', 'specd\'s scanner, plus a model for the judgement sections', 'Partly — the scanned half works without one'],
            ['03 Spec', 'The SpecAgent, on the server or a paired runner', 'Yes'],
            ['04 Gate', 'A named human. Only a human.', 'No — and no agent may do it'],
            ['05 Build', 'The build agent, on the server or a paired runner', 'Yes'],
            ['06 Learn', 'specd, on the merge webhook', 'No'],
          ],
        },
      ],
    },

    {
      slug: 'knowledge-base',
      title: 'The knowledge base',
      summary:
        'What `knowledge/` is, why it lives in your repository rather than in specd, and what keeps it from going stale.',
      audience: 'everyone',
      minutes: 8,
      blocks: [
        {
          k: 'lead',
          text: 'The knowledge base is plain markdown in your own repository. specd holds a derived index it can rebuild from scratch — which means leaving costs you nothing you would miss.',
        },
        { k: 'h2', text: 'What is in it' },
        {
          k: 'p',
          text: 'Grounding writes a starting tree; you shape it from there. This repository\'s own knowledge base — specd develops specd — has the layout the scaffold produces:',
        },
        {
          k: 'code',
          caption: 'knowledge/',
          code: `knowledge/
  README.md            the map — what to read, and when
  architecture.md      module boundaries, data flow, the shape of the system
  conventions.md       how code is written here: layout, lint, test patterns
  glossary.md          domain terms, defined once
  decisions/           ADRs — why a choice was made, numbered and dated
  runbooks/            how to run, deploy and debug it
  specs/               as-built records of everything delivered
  research/            point-in-time analyses of external systems
  open-questions.md    what nobody has answered yet`,
        },
        { k: 'h2', text: 'Why it lives in your repository' },
        {
          k: 'dl',
          items: [
            {
              term: 'Because git already solves the hard parts',
              text: 'History, blame, review, branching, access control. A knowledge base in a vendor database re-implements all of that, worse.',
            },
            {
              term: 'Because docs must ride the change',
              text: 'The working agreement is that documentation is updated in the _same_ pull request as the code it describes. That is only possible if the docs are in the same repository as the code.',
            },
            {
              term: 'Because leaving must be free',
              text: 'Delete your specd project and the knowledge base is still there, in markdown, in your repo, readable without any tool. What you lose is the index, and an index rebuilds.',
            },
          ],
        },
        { k: 'h2', text: '`AGENTS.md` — the working agreements' },
        {
          k: 'p',
          text: 'Grounding also installs an `AGENTS.md` at the repository root: a numbered list of rules for any agent working in the repo, with `CLAUDE.md` importing it so Claude Code picks it up automatically. The rules that matter most:',
        },
        {
          k: 'p',
          text: 'If the repository already has an `AGENTS.md` or `CLAUDE.md`, **nothing in it is rewritten.** Your file stays exactly as it is and specd\'s rules are appended below it, fenced by `<!-- specd:begin -->` markers so a later grounding run updates only that block. Where the two sets disagree, yours came first and a human decides — the setup pull request says so, and `knowledge/open-questions.md` carries it as an item.',
        },
        {
          k: 'ol',
          items: [
            'Read `knowledge/README.md` and the docs it maps to your task **before** implementing anything.',
            'Ground design choices in `knowledge/`, and cite the file you relied on.',
            'Update `knowledge/` in the **same pull request** as the code it describes. Docs ride the change; they never trail it.',
            '`knowledge/specs/` is a historical record. Never rewrite an old spec — append a "Deviations" section if reality diverged.',
            'When the knowledge base does not answer you, do not invent the answer. Check `open-questions.md`, and say so.',
          ],
        },
        {
          k: 'note',
          tone: 'good',
          title: 'Three of those rules are enforced by software',
          text: 'The server refuses to serve an unapproved spec, the webhook matches merged `spec/<ID>-<slug>` branches back to their spec, and the build station files the as-built record itself. The [Claude Code plugin](/docs/agent-integrations) makes two more bind at the moment they are broken, with a hook that blocks an edit on an unapproved spec branch and a hook that asks whether rule 3 was met.',
        },
        { k: 'h2', text: 'How specd reads it' },
        {
          k: 'p',
          text: 'Indexing is deterministic and atomic, and **no model ever runs at index time**. Documents are chunked on headings, embedded, and their links extracted with parser rules across five deterministic kinds — `citation`, `wikilink`, `symbolref`, `mdlink`, `coderef`. A hallucinated edge would poison retrieval invisibly, so the indexer is not allowed to invent one.',
        },
        {
          k: 'p',
          text: 'It also indexes your **code**: the file tree and its declarations, for TypeScript, Go and Python. That is what lets a doc citing `RunnerJobsService.claim()` resolve to the real symbol, and lets retrieval serve the function\'s actual source as a citable excerpt. The full mechanism is in [The retrieval engine](/docs/retrieval-engine).',
        },
        { k: 'h2', text: 'Health — knowing when it has rotted' },
        {
          k: 'p',
          text: 'A knowledge base is only load-bearing if you can tell when it stops being true. specd scores four things it can count honestly:',
        },
        {
          k: 'table',
          head: ['Signal', 'What it means'],
          rows: [
            ['Broken links', 'A link points at a document that does not exist.'],
            ['Dangling anchors', 'A link points at a real document but a heading that is gone.'],
            ['Orphans', 'A document nothing links to — usually a doc that fell out of the map.'],
            ['Stale code references', 'A doc cites a symbol that no longer exists in the source.'],
          ],
        },
        {
          k: 'p',
          text: 'Drift is measured **against the code, not the calendar**. Doc↔code coupling is mined from a bounded window of git history, so the signal reads _"6 commits touched `apps/api/src/runners/` since this doc last moved with it"_ — which names the code to go read. A 90-day timer only measures time passing.',
        },
        {
          k: 'note',
          tone: 'warn',
          title: 'Unmeasured is not fresh',
          text: 'A document with no commit date reports its freshness as _unmeasured_ rather than fresh. Truncation notices fire only when matching material was really cut. The rule across the whole engine is that an honest "I do not know" beats a confident default.',
        },
        { k: 'h2', text: 'Keeping it good' },
        {
          k: 'ul',
          items: [
            'Answer `UNVERIFIED` markers as you meet them, in the pull request where you learned the answer — and delete the marker in the same change.',
            'Keep `knowledge/README.md` as a real map. Every doc should be reachable from it; that is what makes the orphan count meaningful.',
            'Write decisions down when you make them, not when you are asked to justify them. An ADR is cheap the day of, expensive a quarter later.',
            'Let `knowledge/specs/` accumulate. It is the corpus the next spec retrieves — see [The learning loop](/docs/learning-loop).',
          ],
        },
      ],
    },

    {
      slug: 'specs-and-citations',
      title: 'Specs and citations',
      summary:
        'What a spec contains, what a citation promises, and the four verdicts that make the promise checkable.',
      audience: 'everyone',
      minutes: 9,
      blocks: [
        {
          k: 'lead',
          text: 'A spec is only worth a gate if a reviewer can check it faster than they could write it. Citations are what make that true — and a citation is only worth having if someone can verify it.',
        },
        { k: 'h2', text: 'The three sections' },
        {
          k: 'steps',
          items: [
            {
              title: 'Requirements — EARS-shaped, therefore testable',
              text: 'Acceptance criteria written as _when_ ‹trigger›, the system _shall_ ‹response›. The shape is not ceremony: a "shall" statement is exactly what a test asserts, so a requirement that cannot be written this way is usually a requirement nobody has pinned down yet.',
            },
            {
              title: 'Design — every claim cited or flagged',
              text: 'The approach, the affected modules, the trade-offs. Each claim points at a passage in your knowledge base, or carries `UNVERIFIED`. There is no third option where the agent asserts something unattributable.',
            },
            {
              title: 'Tasks — each one pull request',
              text: 'An ordered list, implemented in order, one commit per task. The final task of every spec is always the same: file the as-built record into `knowledge/specs/`.',
            },
          ],
        },
        { k: 'h2', text: 'What a citation is' },
        {
          k: 'p',
          text: 'A citation is a `CITE-AS` string that identifies a specific passage — a document, and a section within it. It is produced by retrieval, not composed by the model afterwards, which is the property that makes it followable: the agent cites what it was actually shown.',
        },
        {
          k: 'code',
          caption: 'a design claim, cited',
          code: `Jobs are claimed with FOR UPDATE SKIP LOCKED so two runners
polling the same queue cannot take the same row.
  — per knowledge/architecture.md#runner-job-queue`,
        },
        {
          k: 'note',
          tone: 'rule',
          title: 'A citation means someone can check it',
          text: 'Citations are validated against what was actually retrieved. A path the model invented is demoted to `UNVERIFIED` rather than printed as a reference — because a citation that cannot be followed is worse than no citation at all: it buys trust it has not earned.',
        },
        { k: 'h2', text: 'The four verdicts' },
        {
          k: 'p',
          text: 'Verification returns one of four answers, and the distinctions between them are the whole point.',
        },
        {
          k: 'table',
          head: ['Verdict', 'Means', 'What you should do'],
          rows: [
            [
              '`supported`',
              'The passage exists and says what the claim says it says.',
              'Nothing. This is the normal case.',
            ],
            [
              '`unsupported`',
              'Checked, and wrong — no such document, or no such section.',
              'Treat the claim as unfounded. Something in the draft is confused.',
            ],
            [
              '`unknown`',
              'The corpus could not answer: the document never reached the prompt, holds no indexed content, or was cut for budget.',
              'Look yourself. This is a gap in retrieval, not evidence of anything.',
            ],
            [
              '`stale`',
              'The passage is real, but it describes **code that changed since the doc was last touched**.',
              'Read the code. The doc, the claim, or both, need updating.',
            ],
          ],
        },
        {
          k: 'quote',
          text: '"I found no evidence" and "no evidence exists" are different answers, and only one of them is safe to write into a spec.',
        },
        {
          k: 'p',
          text: 'The same four verdicts come out of `verify_citation` over [MCP](/docs/mcp) — from the same function. A citation that is `supported` inside a spec and `unsupported` when anyone checks it would make the verdict worthless.',
        },
        { k: 'h2', text: '`UNVERIFIED` is a feature' },
        {
          k: 'p',
          text: 'When the agent cannot ground a claim, it marks it and moves on. That marker is the most valuable line in the spec: it is the agent telling you precisely where it would have had to guess.',
        },
        {
          k: 'ul',
          items: [
            'Read every one before approving. Each is a decision being handed to you.',
            'Answer it in the knowledge base, not just in the spec — otherwise the next spec asks again.',
            'Never treat the marker as a formality to clear. A team that learns to skim past `UNVERIFIED` has converted an honest signal into decoration.',
          ],
        },
        { k: 'h2', text: 'Versions are append-only' },
        {
          k: 'p',
          text: 'Approving pins the approval to that exact version. A revision creates v2; v1 keeps its stamp exactly as recorded, and `approved → draft` is refused. There is no edit-in-place, so "what was approved" is always answerable — which is the property an audit actually needs.',
        },
        { k: 'h2', text: 'How the spec is drafted' },
        {
          k: 'p',
          text: 'Three bounded retrieval stages feed the SpecAgent, and each is described in full in [The retrieval engine](/docs/retrieval-engine):',
        },
        {
          k: 'ol',
          items: [
            'Reciprocal Rank Fusion over vector similarity (pgvector) and Postgres full-text search — headings outrank body text, and one document cannot take every slot.',
            'A one-hop expansion across resolved links in the document graph, edge-kind weighted and hub-gated, with every added chunk carrying the edge that pulled it in.',
            'Up to two **code snippets** — the actual source of symbols the seed documents reference, read from the repository at retrieval time and citable as `path#Class.method`.',
          ],
        },
        {
          k: 'note',
          tone: 'info',
          title: 'Retrieved, not remembered',
          text: 'Everything the SpecAgent cites was in its prompt because retrieval put it there. That is why the citations resolve, and why a spec drafted against an empty knowledge base is mostly `UNVERIFIED` rather than confidently wrong.',
        },
      ],
    },

    {
      slug: 'the-human-gate',
      title: 'The human gate',
      summary:
        'The approval step at station 04: what it records, where it is enforced, and why no agent — including specd\'s own — can open it.',
      audience: 'everyone',
      minutes: 6,
      blocks: [
        {
          k: 'lead',
          text: 'One named person approves one version of one spec. Nothing downstream runs without that record, and the record cannot be forged, backdated or produced by an agent.',
        },
        { k: 'h2', text: 'What approving records' },
        {
          k: 'dl',
          items: [
            { term: 'Who', text: 'A named, signed-in human. Not a service account, not an agent, not "the system".' },
            { term: 'What', text: 'A specific version of a specific spec — v1, not "the spec".' },
            { term: 'When', text: 'A timestamp, kept exactly as recorded even after the spec is superseded.' },
          ],
        },
        { k: 'h2', text: 'Where it is enforced' },
        {
          k: 'p',
          text: 'Three independent layers, so no single mistake opens the gate. This is the difference between a rule and an invariant.',
        },
        {
          k: 'table',
          head: ['Layer', 'What it refuses'],
          rows: [
            [
              'The state machine',
              'A transition to `approved` with no actor. There is no code path that produces an unattributed approval.',
            ],
            [
              'The API boundary',
              'CLI tokens are audience-scoped and rejected on every route that authors or approves. `specd spec pull` is refused server-side for anything unapproved.',
            ],
            [
              'A database CHECK constraint',
              'An approved row with no approver. Even a direct `UPDATE` against the database cannot record one.',
            ],
          ],
        },
        {
          k: 'note',
          tone: 'rule',
          title: 'The gate is re-checked at the point of use',
          text: 'Approval is not a flag consulted once at dispatch. When the build station is asked to run, it re-checks — an unapproved spec gets the same 409 the CLI gets, at the exact moment agent output would first reach code.',
        },
        { k: 'h2', text: 'Why no agent can open it' },
        {
          k: 'p',
          text: 'An agent that could approve its own spec would make the gate decorative — the system would be reviewing itself and reporting that it agreed. So the capability does not exist anywhere an agent can reach:',
        },
        {
          k: 'ul',
          items: [
            'The **CLI** fetches, registers and reports. It never authors, reviews or approves — the server refuses those for CLI tokens regardless of what the binary asks.',
            'The **MCP server** is read-only by construction rather than by convention. It carries the same CLI-audience token, so approving through it is not blocked — it is impossible.',
            'The **Claude Code plugin**\'s hooks can block an edit; neither can approve anything.',
          ],
        },
        {
          k: 'quote',
          text: 'A plugin that could open the gate would defeat the product.',
          cite: 'knowledge/decisions/0018-working-agreements-ship-as-a-plugin.md',
        },
        { k: 'h2', text: 'Approval is append-only' },
        {
          k: 'p',
          text: '`approved → draft` is refused. A change means a new version: v2 supersedes v1, and v1 keeps its approval stamp exactly as recorded. Nothing rewrites history, so the question "what did we approve, and who approved it?" always has an answer.',
        },
        { k: 'h2', text: 'Gating your own CI on it' },
        {
          k: 'p',
          text: 'The gate is available to your pipeline too. `specd spec status` exits **3** when a spec exists but is not approved — deliberately distinct from a generic failure, so a script can tell "not approved yet" from "could not reach specd".',
        },
        {
          k: 'code',
          caption: '.github/workflows/…',
          code: `- name: Require an approved spec
  run: |
    specd spec status "$SPEC_ID"
    case $? in
      0) echo "approved — building" ;;
      3) echo "::error::$SPEC_ID is not approved yet"; exit 1 ;;
      *) echo "::error::could not reach specd"; exit 1 ;;
    esac`,
        },
        { k: 'h2', text: 'Running the gate well' },
        {
          k: 'ul',
          items: [
            '**Name an owner per project.** An unowned approval queue is a stalled queue, and the failure mode is that people route around it.',
            '**Approve versions, not intentions.** If the spec is nearly right, ask for v2. Approving "the idea" and fixing it in review puts you back where you started.',
            '**Do not batch-approve.** Four specs stamped in ninety seconds is the exact failure this station exists to prevent.',
          ],
        },
        {
          k: 'p',
          text: 'A reviewer\'s checklist is at [Reviewing and approving a spec](/docs/review-and-approve).',
        },
      ],
    },

    {
      slug: 'learning-loop',
      title: 'The learning loop',
      summary:
        'Why the loop closes on merge, what an as-built spec is, and how the twentieth spec ends up better grounded than the first.',
      audience: 'everyone',
      minutes: 6,
      blocks: [
        {
          k: 'lead',
          text: 'Most AI tooling is flat: session twenty is exactly as informed as session one. specd is shaped the other way — every delivered spec becomes retrievable context for the next one.',
        },
        { k: 'h2', text: 'What happens on merge' },
        {
          k: 'p',
          text: 'Merging is the only event that matters. Closing a pull request without merging changes nothing, on purpose.',
        },
        {
          k: 'table',
          head: ['What was merged', 'What specd does'],
          rows: [
            ['The setup branch from Ground', 'Records adoption and indexes `knowledge/`.'],
            ['A `spec/<ID>-<slug>` branch', 'Marks the spec delivered and re-indexes.'],
            ['Anything touching `knowledge/` on the default branch', 'Re-indexes.'],
            ['A pull request that was closed, not merged', 'Nothing.'],
          ],
        },
        { k: 'h2', text: 'The as-built spec' },
        {
          k: 'p',
          text: 'The last task of every spec is to file its as-built record into `knowledge/specs/<id>-<slug>.md`. Two properties matter:',
        },
        {
          k: 'dl',
          items: [
            {
              term: 'It is written by specd, not by the model',
              text: 'A verbatim copy of what was approved. If the model omits the task, specd appends the record itself — so the loop cannot quietly stop closing.',
            },
            {
              term: 'It is a historical record',
              text: 'Never rewritten. If reality diverged from the approved design, that is appended as a "Deviations" section — because the useful artifact is what was decided _and_ what actually happened, not a tidied version of either.',
            },
          ],
        },
        {
          k: 'note',
          tone: 'good',
          title: 'This is why the loop closes on merge rather than on approval',
          text: 'What is worth remembering is what shipped, not what was planned. An as-built filed at approval time would be a record of intentions.',
        },
        { k: 'h2', text: 'Why it compounds' },
        {
          k: 'p',
          text: 'The as-built specs are indexed like every other document, so the next draft retrieves them. In practice that changes what the agent has to guess about:',
        },
        {
          k: 'ol',
          items: [
            '**Spec 1** is drafted against whatever grounding found. Expect several `UNVERIFIED` claims — the corpus is thin.',
            '**Spec 5** retrieves four delivered specs. Patterns you established are now citable, so the agent proposes them instead of inventing alternatives.',
            '**Spec 20** is drafted against nineteen decisions that were actually shipped, plus the ADRs and corrections that accumulated along the way. The `UNVERIFIED` count is now a signal about genuinely new territory, not about a cold start.',
          ],
        },
        { k: 'h2', text: 'What keeps it honest' },
        {
          k: 'ul',
          items: [
            'The index refresh is **atomic and shrink-guarded** — a run that would gut the index is refused, and a run that drops edges from documents it never touched is rolled back.',
            'Freshness and coupling are recomputed from git, so a document that stopped moving with the code it describes starts saying so.',
            'Nothing is re-derived by a model at index time, so the corpus cannot drift by being re-summarised.',
          ],
        },
        {
          k: 'p',
          text: 'The mechanics of the refresh are in [Architecture](/docs/architecture); what the index does with the corpus afterwards is in [The retrieval engine](/docs/retrieval-engine).',
        },
      ],
    },
  ],
};
