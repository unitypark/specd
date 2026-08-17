import type { DocCategory } from './types';

/*
 * Start here — written for someone who has never heard of specd, including
 * someone who does not write code. No term is used before it is defined, and
 * the first two pages contain no commands at all: a reader who is evaluating
 * the idea should not have to install anything to finish them.
 */
export const START: DocCategory = {
  title: 'Start here',
  blurb: 'What specd is, why it exists, and how to get it running in five minutes.',
  pages: [
    {
      slug: 'what-is-specd',
      title: 'What is specd?',
      summary:
        'specd is a delivery platform that turns a ticket into a written, cited, human-approved specification — and only then lets an AI agent write code.',
      audience: 'everyone',
      minutes: 6,
      blocks: [
        {
          k: 'lead',
          text: 'AI coding agents are fast and confident, and they will happily build the wrong thing. specd puts one document between the request and the code: a **spec** that a named person on your team read and approved.',
        },
        { k: 'h2', text: 'The problem, in one paragraph' },
        {
          k: 'p',
          text: 'A coding agent given a two-sentence ticket has to invent everything the ticket left out — your architecture, your naming, which service owns what, what "done" means. It invents plausibly, which is the dangerous part: the pull request looks right. The gap between "looks right" and "is right" is discovered in review, in QA, or in production, and by then the cost of the misunderstanding has multiplied.',
        },
        {
          k: 'p',
          text: 'The usual fixes make it worse. Longer prompts do not survive the next session. A wiki nobody updates is a wiki the agent cites while it is wrong. And a human reviewing 600 lines of generated code is reviewing the _output_ of a decision they never got to see.',
        },
        { k: 'h2', text: 'What specd does instead' },
        {
          k: 'p',
          text: 'specd moves the review earlier — to the point where a change is still a paragraph and not a diff. It does that with four moving parts.',
        },
        {
          k: 'steps',
          items: [
            {
              title: 'It reads your repositories and writes a knowledge base',
              text: 'Manifests, CI workflows, compose files, `.env.example`, schemas, the workspace layout. What it finds becomes plain markdown under `knowledge/` in _your_ repository, delivered as a pull request you review. What it could not establish is marked `UNVERIFIED` rather than guessed at.',
            },
            {
              title: 'It drafts every ticket into a spec, with citations',
              text: 'Requirements you can test, a design section where every claim links to the passage in your own docs that supports it, and a task list sized so each task is one pull request.',
            },
            {
              title: 'A named human approves it',
              text: 'This is the gate, and it is the product. Nothing downstream runs on an unapproved spec — not the agent, not the CLI, not a script that asks nicely. The approval is recorded against that exact version, permanently.',
            },
            {
              title: 'The agent builds only what was approved, and the result files itself back',
              text: 'One commit per task, on the spec\'s own branch, opened as a pull request you merge. Merging files the as-built spec into `knowledge/specs/` — so the next spec retrieves it, and the fifth spec is better grounded than the first.',
            },
          ],
        },
        {
          k: 'note',
          tone: 'rule',
          title: 'The one rule the whole product enforces',
          text: 'Agents never implement from a bare prompt. They read the knowledge base first, work from a human-approved spec, and write what they built back into the knowledge base in the same pull request. Everything else in specd exists to make that rule true in practice rather than aspirational.',
        },
        { k: 'h2', text: 'The line' },
        {
          k: 'p',
          text: 'Every project gets the same six stations, in the same order. This is not a workflow builder — there is nothing to assemble, and nothing to mis-wire.',
        },
        {
          k: 'code',
          caption: 'the pipeline · fixed for every project',
          code: `Connect → Ground → Spec → [HUMAN] → Build → Learn
   01       02       03      04       05      06
                                              └──→ feeds 02`,
        },
        {
          k: 'p',
          text: 'Stations cannot be added, skipped or removed. Only station 01 takes configuration — which repository, which model, which tracker. The gate at 04 is structural: no agent may approve its own input, and the server refuses to serve an unapproved spec no matter who asks. Read them one by one in [The six stations](/docs/the-pipeline).',
        },
        { k: 'h2', text: 'What makes the specs worth trusting' },
        {
          k: 'p',
          text: 'A spec is only useful if a reviewer can check it faster than they could write it. Two properties do that work.',
        },
        {
          k: 'dl',
          items: [
            {
              term: 'Every design claim is cited or flagged',
              text: 'A claim either points at a passage in your knowledge base, or it says `UNVERIFIED`. There is no third option where the agent asserts something and nobody can tell where it came from.',
            },
            {
              term: 'Citations are checked, with four possible answers',
              text: '`supported`, `unsupported` (checked and wrong), `unknown` (the corpus could not answer) and `stale` (the passage is real, but the code it describes has changed since). "I found no evidence" and "no evidence exists" are different answers, and only one of them is safe to write into a spec.',
            },
          ],
        },
        {
          k: 'p',
          text: 'The machinery behind that is described in [Specs and citations](/docs/specs-and-citations) and [The retrieval engine](/docs/retrieval-engine).',
        },
        { k: 'h2', text: 'What specd is not' },
        {
          k: 'ul',
          items: [
            '**Not an autonomous agent.** It cannot merge, cannot push to a default branch, and cannot approve anything. Every change arrives as a pull request with your name on the approval that authorised it.',
            '**Not a place your code lives.** Git stays the source of truth. `knowledge/` is plain markdown in your repository; specd holds a derived index it can rebuild. Delete the project and you lose nothing you would miss.',
            '**Not a model.** You bring one — an API key, or the Claude subscription already signed in on your machine. specd never holds a subscription credential.',
            '**Not a ticket tracker.** Jira stays Jira. specd links to the ticket and mirrors status back.',
          ],
        },
        { k: 'h2', text: 'Who it is for' },
        {
          k: 'table',
          head: ['If you are…', 'specd gives you…'],
          rows: [
            [
              'An engineer using a coding agent',
              'An agent that has already read your architecture, cites the doc behind each decision, and flags what it could not ground instead of guessing.',
            ],
            [
              'A tech lead or reviewer',
              'A one-page spec to review instead of a 600-line diff — and the ability to catch a wrong assumption before it becomes code.',
            ],
            [
              'An engineering manager or director',
              'A named, timestamped approval on every AI-authored change, and a knowledge base that improves as a by-product of shipping. See [For engineering leaders](/docs/for-engineering-leaders).',
            ],
            [
              'Someone in a regulated or audited environment',
              'An append-only approval record tied to a specific spec version, enforced by a database constraint rather than by policy.',
            ],
          ],
        },
        { k: 'h2', text: 'Project status, stated honestly' },
        {
          k: 'note',
          tone: 'warn',
          title: 'Pre-1.0 and local-first',
          text: 'specd runs the whole loop end to end on your machine, with a test suite and CI gating it against a real Postgres. Nothing deploys it as a hosted service yet. Jira sync is one-way, billing is metered but not charged, and the default embedder is lexical until you point it at a real embedding model. The full list is in [FAQ · what is not built yet](/docs/faq).',
        },
        { k: 'h2', text: 'Next' },
        {
          k: 'cards',
          items: [
            {
              title: 'Why spec-driven delivery',
              text: 'The argument, and what actually changes for a team that adopts it.',
              href: '/docs/why-spec-driven',
            },
            {
              title: 'Quickstart',
              text: 'One command, five minutes, entirely on your machine.',
              href: '/docs/quickstart',
            },
            {
              title: 'Glossary',
              text: 'Every term specd uses, defined once.',
              href: '/docs/glossary',
            },
          ],
        },
      ],
    },

    {
      slug: 'why-spec-driven',
      title: 'Why spec-driven delivery',
      summary:
        'The case for approving a specification instead of reviewing a diff — what it costs, what it buys, and where it does not pay off.',
      audience: 'leadership',
      minutes: 8,
      blocks: [
        {
          k: 'lead',
          text: 'The expensive defects in AI-assisted delivery are not syntax errors. They are misunderstandings, shipped confidently. A spec is where a misunderstanding is cheapest to find.',
        },
        { k: 'h2', text: 'Where the cost actually lands' },
        {
          k: 'p',
          text: 'The cost of a wrong assumption is roughly the amount of work built on top of it before anyone notices. Coding agents raised the amount of work that can sit on top of an assumption before a human looks — that is what "10× faster" means in practice. The correction cost went up with it.',
        },
        {
          k: 'table',
          head: ['Caught at', 'What you are reading', 'What it costs to fix'],
          rows: [
            ['The spec', 'A paragraph and a list of criteria', 'A comment and one edit'],
            ['Code review', '600 lines that all look plausible', 'A rewrite, plus the review time already spent'],
            ['QA', 'A behaviour that is wrong but works', 'A rewrite, a re-test, and a schedule slip'],
            ['Production', 'An incident', 'All of the above, plus the incident'],
          ],
        },
        {
          k: 'p',
          text: 'Reviewing a spec is not extra work added to reviewing a diff. It is the same review, moved to where it is cheap — and it is a review a non-author can actually do, because a spec is written in the language of the problem rather than the language of the solution.',
        },
        { k: 'h2', text: 'Why "just write better prompts" does not hold' },
        {
          k: 'dl',
          items: [
            {
              term: 'A prompt is not durable',
              text: 'The context you assembled by hand is gone at the end of the session. The next ticket starts from zero, and so does the next engineer.',
            },
            {
              term: 'A prompt is not reviewable',
              text: 'Nobody reviews a prompt. There is no artifact with a name on it, so there is nothing to disagree with before the code exists.',
            },
            {
              term: 'A prompt is not accountable',
              text: 'When a generated change turns out to be wrong, "the AI wrote it" is not an answer an organisation can use. A spec with an approver is.',
            },
          ],
        },
        {
          k: 'quote',
          text: 'The review a team can actually sustain is the one that reads a page, not the one that reads a diff nobody has time for.',
        },
        { k: 'h2', text: 'Why the knowledge base is the other half' },
        {
          k: 'p',
          text: 'A gate without grounding just slows you down: a human approving specs that were invented from nothing is a human doing the agent\'s research for it. The knowledge base is what makes the spec cheap to produce _and_ cheap to check.',
        },
        {
          k: 'ul',
          items: [
            'It is written **in your repository**, as markdown, in the same pull request as the code it describes — so it cannot silently fall behind.',
            'It is **retrieved, not recited**: the agent pulls the passages that answer this ticket, and cites them by a string a reviewer can look up.',
            'It **compounds**: the last task of every spec files the as-built record back into `knowledge/specs/`, so the twentieth spec is written against nineteen delivered ones.',
          ],
        },
        {
          k: 'note',
          tone: 'info',
          title: 'The compounding is the point',
          text: 'Most AI tooling is flat — session twenty is exactly as informed as session one. specd is the opposite shape: every delivered spec is retrievable context for the next one, which is why the loop closes on merge rather than on approval.',
        },
        { k: 'h2', text: 'What it costs' },
        {
          k: 'p',
          text: 'Be honest with your team about the price, because it is real and it lands in a specific place.',
        },
        {
          k: 'dl',
          items: [
            {
              term: 'A review step that did not exist before',
              text: 'Someone has to read and approve the spec. In practice this is minutes, not hours — the spec is a page, and the citations are what make it skimmable. But it is a new named responsibility, and if nobody owns it the queue stalls.',
            },
            {
              term: 'A one-time grounding pass',
              text: 'Onboarding drafts the knowledge base by reading the repo, and someone has to review that pull request properly. Skimming it defeats the point: everything downstream cites it.',
            },
            {
              term: 'Discipline about `UNVERIFIED`',
              text: 'An unanswered question is only useful if somebody eventually answers it. A team that learns to ignore the marker has re-created the wiki nobody trusts.',
            },
          ],
        },
        { k: 'h2', text: 'Where it does not pay off' },
        {
          k: 'ul',
          items: [
            'A typo fix, a dependency bump, a copy change. There is no misunderstanding to catch, so the spec is pure overhead — do it the normal way.',
            'Genuine exploration, where the point is to find out what the problem is. Spec the thing you learned, not the learning.',
            'A codebase nobody intends to keep. Grounding a repository you are about to delete is work you will not get back.',
          ],
        },
        {
          k: 'p',
          text: 'specd does not force itself into those paths — it is a lane for the changes that carry risk, not a replacement for your entire git workflow.',
        },
        { k: 'h2', text: 'How you would know it worked' },
        {
          k: 'p',
          text: 'The claim "the AI helps" should be a number you can check. These are the ones worth watching, and specd instruments the pipeline it installs so they come from your own delivery rather than from a vendor slide.',
        },
        {
          k: 'table',
          head: ['Signal', 'What a healthy number looks like', 'What a bad one is telling you'],
          rows: [
            [
              'Ticket → approved spec, median',
              'Days, trending down as the knowledge base fills in',
              'Weeks — the specs are not answerable from your docs yet',
            ],
            [
              'First-pass PR acceptance',
              'Rising: the spec caught what review used to',
              'Flat — the spec is being approved without being read',
            ],
            [
              'Citations per spec',
              'Rising with knowledge-base coverage',
              'Near zero — retrieval is not finding your docs',
            ],
            [
              '`UNVERIFIED` claims per spec',
              'Falling as open questions get answered',
              'Rising — the docs are drifting from the code',
            ],
          ],
        },
        {
          k: 'note',
          tone: 'warn',
          title: 'Do not tune the last one to zero',
          text: 'An `UNVERIFIED` marker is the agent telling the truth about a gap. A team that optimises the count away by relaxing what counts as grounded has turned an honest signal into a decorative one.',
        },
        { k: 'h2', text: 'Next' },
        {
          k: 'cards',
          items: [
            {
              title: 'For engineering leaders',
              text: 'Rolling it out: who approves, what changes for the team, what to measure.',
              href: '/docs/for-engineering-leaders',
            },
            {
              title: 'The human gate',
              text: 'Exactly how the approval is enforced, and why it cannot be routed around.',
              href: '/docs/the-human-gate',
            },
            {
              title: 'Quickstart',
              text: 'See it work on your own machine before you argue about it.',
              href: '/docs/quickstart',
            },
          ],
        },
      ],
    },

    {
      slug: 'quickstart',
      title: 'Quickstart',
      summary:
        'Clone, run one command, and have specd running locally against a real Postgres in about five minutes.',
      audience: 'engineering',
      minutes: 7,
      blocks: [
        {
          k: 'lead',
          text: 'specd is local-first and pre-1.0: you run it on your own machine, against your own Postgres, with your own model credential. There is no hosted service to sign up for.',
        },
        { k: 'h2', text: 'Prerequisites' },
        {
          k: 'table',
          head: ['You need', 'Why'],
          rows: [
            [
              '**Node ≥ 22** and **pnpm 10.32.1**',
              'The workspace pins pnpm through `packageManager`. On Node 22–24, `corepack enable` once activates the pinned version automatically. Node 25 dropped corepack from the distribution — install pnpm yourself instead (`npm i -g pnpm@10.32.1`, or Homebrew).',
            ],
            [
              '**Docker**',
              'Postgres with the `vector` extension (`pgvector/pgvector:pg17`), provisioned by the repo\'s `docker-compose.yml`. Postgres is specd\'s _only_ runtime dependency.',
            ],
            [
              '**Go ≥ 1.25** _(optional)_',
              'Only to build the `specd` CLI. The platform runs without it.',
            ],
            [
              '**A model credential** _(optional)_',
              'The Claude Code CLI already signed in, or an Anthropic API key. Indexing, retrieval, the knowledge graph and health all work with neither — see [Bring your own model](/docs/bring-your-own-model).',
            ],
          ],
        },
        { k: 'h2', text: 'The one-command path' },
        {
          k: 'code',
          caption: 'terminal',
          code: `git clone https://github.com/unitypark/specd.git && cd specd
pnpm install
pnpm demo`,
        },
        {
          k: 'p',
          text: '`pnpm demo` writes a `.env` if there is not one, builds the workspace packages, starts Postgres and **waits for it to actually accept connections**, applies migrations, seeds a project with a fixture repository already connected, and starts both dev servers — printing the URL and a login. Each step announces itself, so a failure names the step instead of arriving as a stack trace three steps later.',
        },
        {
          k: 'note',
          tone: 'info',
          title: 'The demo leaves the repo ungrounded on purpose',
          text: 'Watching Ground read a real repository is the most interesting thing specd does. Pre-baking it would hide the demo\'s best moment.',
        },
        { k: 'h2', text: 'The same thing by hand' },
        {
          k: 'p',
          text: 'If you would rather see each step, this is exactly what `pnpm demo` automates.',
        },
        {
          k: 'steps',
          items: [
            {
              title: 'Clone and configure',
              text: '`cp .env.example .env`. The file only has to **exist** — the dev defaults work as-is, and nothing needs sourcing into your shell: the API, the migration runner and Next.js each load the repo-root `.env` themselves. Every value you would change for a real environment is commented with what it does and how to generate it.',
            },
            {
              title: 'Install and build the workspace packages',
              text: '`pnpm install`, then `pnpm --filter "./packages/*" build`. The build is not optional and install does not do it for you — `@specd/db` and `@specd/shared` are imported through their gitignored `dist/`, so the API cannot start until they have been built once.',
            },
            {
              title: 'Start Postgres',
              text: '`pnpm infra:up`. One container, `specd-postgres` (pgvector on Postgres 17), mapped to host port **5433** so it can never collide with a Postgres you already run on 5432. Data lives in a named volume and survives restarts.',
            },
            {
              title: 'Create the schema',
              text: '`pnpm db:migrate`. Plain-SQL migrations applied in filename order, each in its own transaction, tracked in `_specd_migrations`. Idempotent, so it is also the command to run after pulling commits that added a migration.',
            },
            {
              title: 'Seed a playground',
              text: '`pnpm db:seed` writes a small **fixture git repository** to onboard against, so you can walk the entire pipeline without connecting anything real.',
            },
            {
              title: 'Run it',
              text: '`pnpm dev` starts the API on `:4000` and the web app on `:3000` in parallel. Ctrl-C stops both; Postgres stays up independently.',
            },
          ],
        },
        { k: 'h2', text: 'Verify it is actually up' },
        {
          k: 'code',
          caption: 'terminal',
          code: `curl http://localhost:4000/api/health`,
        },
        {
          k: 'code',
          caption: 'a healthy response',
          code: `{ "status": "ok", "database": "up",
  "ai": "no platform key (BYO key per project)",
  "embeddings": "hash", "defaultModel": "claude-opus-5" }`,
        },
        {
          k: 'p',
          text: '`"ai"` reporting no key is normal and honest — agent runs will fail with a clear error until a project supplies one, and nothing else cares. If anything looks wrong, `specd doctor` reports config, server, database, embeddings, credential, identity and default project in dependency order and skips what an earlier failure makes unknowable.',
        },
        { k: 'h2', text: 'What to do next in the app' },
        {
          k: 'p',
          text: 'Open [localhost:3000](http://localhost:3000), create an account, and the wizard walks the stations. [Your first spec](/docs/your-first-spec) narrates that walk in detail; the short version is: register the seeded fixture repo, let Ground read it, merge the setup branch, draft a spec from a ticket, approve it, build it, merge.',
        },
        {
          k: 'p',
          text: 'You can also exercise the whole loop headlessly over the real HTTP API — steps that need a model are **skipped and labelled**, never silently passed:',
        },
        { k: 'code', caption: 'terminal', code: `pnpm --filter @specd/api loop` },
        { k: 'h2', text: 'Common first-run problems' },
        {
          k: 'table',
          head: ['Symptom', 'Cause', 'Fix'],
          rows: [
            [
              '`DATABASE_URL is required — copy .env.example to .env`',
              'No `.env` at the repo root yet',
              '`cp .env.example .env`, then retry.',
            ],
            [
              'Same error, but `.env` exists',
              'You are not at the repo root, or the value is empty',
              '`grep DATABASE_URL .env` from the repo root should print a real value — the loader looks there, not at the shell\'s cwd.',
            ],
            [
              'API cannot reach Postgres',
              '`pnpm infra:up` never ran, or Docker is down',
              '`docker ps` should list `specd-postgres` as `healthy`.',
            ],
            [
              '`EADDRINUSE` on `:3000` / `:4000`',
              'A previous `pnpm dev` is still running',
              '`lsof -nP -iTCP:3000 -sTCP:LISTEN`, stop it, retry.',
            ],
            [
              'Schema-shaped error right after pulling',
              'New migrations landed',
              '`pnpm db:migrate` — idempotent.',
            ],
            [
              'Web app renders but has no data in it',
              'The API died at startup — often on a missing or stale `packages/*/dist`. `node --watch` keeps the crashed process alive, so `pnpm dev` still looks healthy.',
              '`curl localhost:4000/api/health` to confirm, read the API\'s own output for the reason, then `pnpm --filter "./packages/*" build`.',
            ],
          ],
        },
        {
          k: 'p',
          text: 'The longer list, including the day-two traps, is in [Troubleshooting](/docs/troubleshooting).',
        },
        { k: 'h2', text: 'Next' },
        {
          k: 'cards',
          items: [
            {
              title: 'Your first spec',
              text: 'The full walk: connect, ground, draft, approve, build, merge.',
              href: '/docs/your-first-spec',
            },
            {
              title: 'Bring your own model',
              text: 'Three ways in — subscription, API key, or neither.',
              href: '/docs/bring-your-own-model',
            },
            {
              title: 'CLI reference',
              text: 'Build the binary and drive specd from your terminal or CI.',
              href: '/docs/cli',
            },
          ],
        },
      ],
    },

    {
      slug: 'your-first-spec',
      title: 'Your first spec, end to end',
      summary:
        'A guided walk through all six stations using the seeded fixture repository — what you click, what specd does, and what to look at while it does it.',
      audience: 'everyone',
      minutes: 10,
      blocks: [
        {
          k: 'lead',
          text: 'This is the whole product in one sitting. Follow it with the demo running and you will have connected a repository, grounded it, approved a spec and merged a generated pull request.',
        },
        {
          k: 'note',
          tone: 'info',
          title: 'Before you start',
          text: 'Have [Quickstart](/docs/quickstart) finished and the app open at localhost:3000, signed in. Stations 3 and 5 need a model credential — if you have none, follow along and read what specd produces without one; the page says where that happens.',
        },
        { k: 'h2', text: '01 · Connect — point specd at a repository' },
        {
          k: 'p',
          text: 'In the wizard, register the seeded fixture repository. In a real project you have three ways in: a **local path** (nothing leaves your machine), a **GitHub App installation** (repository-scoped tokens that expire within the hour), or a **GitLab access token**. See [Connect a repository](/docs/connect-a-repository).',
        },
        {
          k: 'p',
          text: 'What to look at: specd records _which repository_, not a copy of it. Your git remains the source of truth for everything that follows.',
        },
        { k: 'h2', text: '02 · Ground — let it read the repo' },
        {
          k: 'p',
          text: 'Grounding reads the repository the way a new engineer would: manifests, CI workflows, compose files, `.env.example`, schemas, the workspace layout. It then opens a **setup pull request** carrying two things — an `AGENTS.md` of working agreements, and a `knowledge/` base.',
        },
        {
          k: 'p',
          text: 'Open that pull request and read it properly. This is the most important review in the whole product, because everything downstream cites it.',
        },
        {
          k: 'dl',
          items: [
            {
              term: 'Tables are quoted, not inferred',
              text: 'Commands, pipelines, services, configuration and entities are quoted from the files they name. If the table says the test command is `pnpm test`, a file in your repo says so.',
            },
            {
              term: 'Judgement is drafted, and labelled as draft',
              text: 'The prose around the tables — what the architecture _means_ — is a draft for you to correct. It is not presented as established fact.',
            },
            {
              term: '`UNVERIFIED` is a question, not a placeholder',
              text: 'Anything the scan could not ground says so. The wizard does not pretend to know your architecture. Answering these is the highest-value editing you will do all week.',
            },
          ],
        },
        { k: 'h2', text: '03 · Adopt — merge the setup branch' },
        {
          k: 'p',
          text: 'Merging **is** the adoption signal. specd indexes `knowledge/` the moment the webhook lands; in local mode there is an "I merged it" button instead. Nothing about adoption is a separate ceremony — the merge you were going to do anyway is the event.',
        },
        {
          k: 'note',
          tone: 'good',
          title: 'You now have an agent that has read your codebase',
          text: 'From here on, anything specd drafts is retrieved from these documents. This is the difference between an agent that starts each session as a stranger and one that opens already knowing the architecture.',
        },
        { k: 'h2', text: '04 · Spec — turn a ticket into something reviewable' },
        {
          k: 'p',
          text: 'Create a ticket on the board (or import one from Jira) and hit **Draft spec**. The SpecAgent retrieves from your knowledge base and writes three sections.',
        },
        {
          k: 'steps',
          items: [
            {
              title: 'Requirements',
              text: 'EARS-shaped acceptance criteria — _when_ ‹trigger›, the system _shall_ ‹response›. Testable by construction, because "shall" statements are what a test asserts.',
            },
            {
              title: 'Design',
              text: 'The approach, with a citation behind every claim. A claim the agent could not ground in your own docs is marked `UNVERIFIED` instead of asserted.',
            },
            {
              title: 'Tasks',
              text: 'An ordered list, each sized to one pull request. The final task of every spec is always the same: file the as-built record into `knowledge/specs/`.',
            },
          ],
        },
        {
          k: 'p',
          text: 'Without a model credential, this step fails with a clear error rather than inventing content — see [Bring your own model](/docs/bring-your-own-model).',
        },
        { k: 'h2', text: '05 · The gate — read it, then approve it' },
        {
          k: 'p',
          text: 'This is the step that only a human can take. [Reviewing and approving a spec](/docs/review-and-approve) is a checklist for doing it well; the short version:',
        },
        {
          k: 'ul',
          items: [
            'Read the **requirements** first and ask whether shipping exactly these would satisfy the ticket. Everything else is downstream of this.',
            'Spot-check two or three **citations**. Click them. A citation is a promise that someone can follow it.',
            'Read every **`UNVERIFIED`** claim. Each one is a decision the agent is asking you to make.',
            'Check the **tasks** are each genuinely one pull request.',
          ],
        },
        {
          k: 'note',
          tone: 'rule',
          title: 'What approving actually does',
          text: 'It records _you_, by name, against _that version_ of the spec, permanently. A revision starts a new version rather than editing the approved one, and `approved → draft` is refused. The state machine will not accept an approval without an actor, and a database CHECK constraint rejects an approved row with no approver — so an unattributed approval cannot exist even via a direct write.',
        },
        { k: 'h2', text: '06 · Build — the agent implements what you approved' },
        {
          k: 'p',
          text: 'Start the build from the spec drawer. Three properties are enforced rather than hoped for:',
        },
        {
          k: 'ul',
          items: [
            '**The gate is re-checked at the point of use.** An unapproved spec gets a 409 at the exact moment agent output would first reach code.',
            '**The agent gets editing tools only — never a shell.** specd runs your repository\'s own verify command itself.',
            '**It never touches your working tree.** Local builds use a throwaway git worktree; the branch survives, the workspace does not.',
          ],
        },
        {
          k: 'p',
          text: 'You get a pull request titled `[<ID>] - <Title>`: one commit per task, on the spec\'s own `spec/<ID>-<slug>` branch. Verify results distinguish **failed** (your tests ran and did not pass) from **could not run** (toolchain missing) — different problems, different reviewers.',
        },
        { k: 'h2', text: '07 · Learn — merge, and watch the loop close' },
        {
          k: 'p',
          text: 'You merge the pull request. The webhook fires, the as-built spec is filed into `knowledge/specs/`, and the index refreshes. That record is now retrievable context for the next spec.',
        },
        {
          k: 'quote',
          text: 'The loop closes on merge, not on approval — because the thing worth remembering is what actually shipped, not what was planned.',
        },
        { k: 'h2', text: 'What you just proved' },
        {
          k: 'ul',
          items: [
            'A ticket became a document a human could check in minutes.',
            'A named person approved it, and that approval is pinned to a version.',
            'An agent built only what was approved, and could not have built anything else.',
            'The knowledge base is one spec richer than it was this morning.',
          ],
        },
        { k: 'h2', text: 'Next' },
        {
          k: 'cards',
          items: [
            {
              title: 'The six stations',
              text: 'Each station in detail, and why the order is fixed.',
              href: '/docs/the-pipeline',
            },
            {
              title: 'Reviewing and approving',
              text: 'A reviewer\'s checklist, and the three failure modes to watch for.',
              href: '/docs/review-and-approve',
            },
            {
              title: 'Agent integrations',
              text: 'Serve the knowledge base to Claude Code, Cursor or anything that speaks MCP.',
              href: '/docs/agent-integrations',
            },
          ],
        },
      ],
    },

    {
      slug: 'glossary',
      title: 'Glossary',
      summary: 'Every term specd uses, defined once, in the order you will meet them.',
      audience: 'everyone',
      minutes: 5,
      blocks: [
        {
          k: 'lead',
          text: 'If a word on another page is unfamiliar, it is defined here. Nothing here assumes you have read anything else.',
        },
        { k: 'h2', text: 'The core objects' },
        {
          k: 'dl',
          items: [
            {
              term: 'Project',
              text: 'One unit of work in specd: a set of repositories, a model credential, an optional tracker, a board and a knowledge base. Everything is scoped to a project.',
            },
            {
              term: 'Knowledge base (`knowledge/`)',
              text: 'Plain markdown in _your_ repository — architecture, conventions, decisions, runbooks, delivered specs. Git is the source of truth; specd keeps a derived index it can rebuild from scratch.',
            },
            {
              term: '`AGENTS.md`',
              text: 'The working agreements installed into your repo at grounding: read `knowledge/` first, cite what you relied on, update the docs in the same pull request. `CLAUDE.md` imports it, so Claude Code picks it up automatically.',
            },
            {
              term: 'Spec',
              text: 'The reviewable unit of change: EARS requirements, a cited design, and tasks each sized to one pull request. Versions are append-only.',
            },
            {
              term: 'The gate',
              text: 'The approval step at station 04. A named human approves a specific version of a spec; nothing downstream runs without it.',
            },
            {
              term: 'As-built spec',
              text: 'The verbatim record of what was approved, filed into `knowledge/specs/` by the last task of every spec. It is a historical record — never rewritten, only appended to with a "Deviations" section if reality diverged.',
            },
          ],
        },
        { k: 'h2', text: 'The pipeline' },
        {
          k: 'dl',
          items: [
            {
              term: 'Station',
              text: 'One of the six fixed steps: Connect, Ground, Spec, the human gate, Build, Learn. They cannot be added, reordered, skipped or removed.',
            },
            {
              term: 'Connect',
              text: 'Registering a repository, a model credential and (optionally) a tracker. The only station that takes configuration.',
            },
            {
              term: 'Ground / onboarding',
              text: 'The read-only scan that produces your first knowledge base and opens the setup pull request.',
            },
            {
              term: 'Adoption',
              text: 'Merging the setup branch. The merge _is_ the signal — there is no separate button in the hosted path.',
            },
            {
              term: 'Build station',
              text: 'The agent run that implements an approved spec, one commit per task, on the spec\'s own branch.',
            },
            {
              term: 'Learn',
              text: 'What happens on merge: the as-built spec is filed and the index refreshes, so the next spec starts better grounded.',
            },
          ],
        },
        { k: 'h2', text: 'How claims are checked' },
        {
          k: 'dl',
          items: [
            {
              term: 'Citation',
              text: 'A pointer from a design claim to the passage that supports it, written as a `CITE-AS` string a reviewer can look up and a tool can verify.',
            },
            {
              term: '`supported`',
              text: 'Verdict: the cited passage exists and says what the claim says it says.',
            },
            {
              term: '`unsupported`',
              text: 'Verdict: checked, and wrong — no such document, or no such section.',
            },
            {
              term: '`unknown`',
              text: 'Verdict: the corpus could not answer. The document never reached the prompt, holds no indexed content, or was cut for budget. Deliberately distinct from `unsupported`: "I found no evidence" and "no evidence exists" are different answers.',
            },
            {
              term: '`stale`',
              text: 'Verdict: the passage is real, but it describes code that has changed since the doc was last touched.',
            },
            {
              term: '`UNVERIFIED`',
              text: 'A marker on a claim the agent could not ground at all. It is a question for a human, never a licence to fill the gap in from guesswork.',
            },
            {
              term: 'EARS',
              text: 'Easy Approach to Requirements Syntax — the "when ‹trigger›, the system shall ‹response›" shape specd writes acceptance criteria in. It exists to make a requirement testable by construction.',
            },
          ],
        },
        { k: 'h2', text: 'The engine' },
        {
          k: 'dl',
          items: [
            {
              term: 'Index run',
              text: 'One atomic pass that chunks, embeds and links documents. Queued as a row and woken by Postgres `LISTEN/NOTIFY` — there is no broker.',
            },
            {
              term: 'Chunk',
              text: 'A document split on headings. The unit that is embedded, retrieved and cited.',
            },
            {
              term: 'Link kinds',
              text: 'The five deterministic edge types extracted by parser rules: `citation`, `wikilink`, `symbolref`, `mdlink`, `coderef`. No model runs at index time — a hallucinated edge would poison retrieval invisibly.',
            },
            {
              term: 'RRF (Reciprocal Rank Fusion)',
              text: 'How the two retrieval arms are combined: vector similarity over pgvector and full-text search over Postgres `tsvector`, merged by rank rather than by score.',
            },
            {
              term: 'Graph expansion',
              text: 'The one hop taken from the retrieved seed documents across resolved links. Every added chunk carries the edge that pulled it in.',
            },
            {
              term: 'Code node',
              text: 'A declaration extracted from your source — a function, class or method — so a doc citing `Service.method()` can resolve to real code and serve it as a citable excerpt.',
            },
            {
              term: 'Coupling',
              text: 'Doc↔code drift mined from a bounded window of git history: _"6 commits touched this directory since this doc last moved with it"_. Measured against the code, not against a 90-day timer.',
            },
            {
              term: 'Shrink guard',
              text: 'The refusal to commit an index run that would gut the index — an empty listing against a non-empty index is rejected at any size.',
            },
            {
              term: 'Health',
              text: 'The scored count of broken links, dangling anchors, orphans and stale code references in a knowledge base.',
            },
          ],
        },
        { k: 'h2', text: 'Running it' },
        {
          k: 'dl',
          items: [
            {
              term: 'Runner',
              text: 'A machine paired to a project that claims and executes jobs — spec, onboard, build — using its own local Claude Code and its own git credentials.',
            },
            {
              term: 'Lease',
              text: 'The window a claimed job is held for. A runner that stops heartbeating loses the job back to the queue (180s; builds 900s), and after three reclaims the job is failed as repeatedly abandoned.',
            },
            {
              term: 'Subscription runner mode',
              text: '`SPECD_AI_MODE=subscription_runner` — specd drives the Claude Code CLI already signed in on the machine. It never sees, stores or proxies the credential, which is also why a hosted specd could not offer this mode.',
            },
            {
              term: 'MCP',
              text: 'Model Context Protocol. `specd mcp serve` puts the retrieval engine behind it, so an agent in Claude Code, Cursor or Windsurf can ask the knowledge base instead of grepping. Read-only by construction.',
            },
          ],
        },
        {
          k: 'note',
          tone: 'info',
          title: 'Missing a term?',
          text: 'This repository keeps its own glossary at `knowledge/glossary.md`, and the product eats its own food: that file is indexed by the same engine described here.',
        },
      ],
    },
  ],
};
