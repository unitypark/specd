import type { DocCategory } from './types';

/*
 * Guides — task-shaped. Each page answers "how do I do X", assumes the reader
 * has the app running, and links back to the concept page rather than
 * re-explaining it.
 */
export const GUIDES: DocCategory = {
  title: 'Guides',
  blurb: 'Task-shaped walkthroughs for the things you will actually do.',
  pages: [
    {
      slug: 'connect-a-repository',
      title: 'Connect a repository',
      summary:
        'The three ways in — a local path, a GitHub App installation, or a GitLab token — and what each one lets specd do.',
      audience: 'engineering',
      minutes: 7,
      blocks: [
        {
          k: 'lead',
          text: 'specd never copies your repository. It records which one, and reads it when it needs to. What differs between the three connection modes is only how it reads and writes.',
        },
        { k: 'h2', text: 'Choosing a mode' },
        {
          k: 'table',
          head: ['Mode', 'Reads', 'Writes', 'Use it when'],
          rows: [
            [
              '**Local path**',
              'From disk',
              'A local branch you push yourself',
              'Evaluating specd, or working on a repository that must not leave the machine.',
            ],
            [
              '**GitHub App**',
              'Repository-scoped API token',
              'Branch + pull request',
              'GitHub-hosted work. This is the recommended production path.',
            ],
            [
              '**GitLab access token**',
              'GitLab API',
              'Branch + merge request',
              'gitlab.com or self-managed GitLab.',
            ],
          ],
        },
        { k: 'h2', text: 'Local path' },
        {
          k: 'p',
          text: 'The simplest mode, and the one the seeded fixture repository uses. Register the current directory from the CLI:',
        },
        { k: 'code', caption: 'terminal', code: `specd connect .` },
        {
          k: 'p',
          text: 'Code stays on your machine. In place of a merge webhook you get an "I merged it" button in the app, so adoption and delivery are still explicit events rather than assumptions.',
        },
        {
          k: 'p',
          text: 'Where `origin` points at github.com or gitlab.com and that host\'s CLI (`gh`, `glab`) is installed and signed in on the same machine, setup and build branches are pushed and opened as real pull requests through **your** account. The CLI is checked before anything is pushed, so a repository specd cannot open a review on is never published to. Set `SPECD_LOCAL_OPEN_PR=0` to keep everything local; the branch is committed either way.',
        },
        {
          k: 'p',
          text: 'For a **self-managed** GitLab or GitHub Enterprise, that is not enough: specd refuses to guess what software a host runs from its URL, and the host\'s CLI is often not on a corporate machine. So the local step asks which host to open reviews on — and for GitLab, that is usually all it needs.',
        },
        {
          k: 'note',
          tone: 'good',
          title: 'GitLab needs no token here',
          text: 'GitLab can open the merge request as part of the push (`git push -o merge_request.create`). That travels over the git transport — the connection you already clone and push through — so it needs no API call, no credential, and works where an access portal intercepts `/api/v4`. specd tries it first. A token stays available as a fallback, and GitHub still requires one because pull requests there are API-only.',
        },
        {
          k: 'p',
          text: 'The instance URL is derived from your repository\'s `origin`, so it is normally left blank. Set it only for an instance served from a subpath (`https://host/gitlab`), plain http, or a non-standard API port — and give the instance **root**, never a group or project page. Where the two readings are genuinely ambiguous, specd asks the instance rather than guessing.',
        },
        {
          k: 'note',
          tone: 'rule',
          title: 'The review credential is not a second connection',
          text: 'It never reads a file, lists a tree, clones or pushes — your own git credentials still do the push, and specd still reads the repository from disk. Leave it unset and local mode holds no credential at all, exactly as before.',
        },
        { k: 'h2', text: 'GitHub — as an App, not a personal token' },
        {
          k: 'p',
          text: 'specd connects to GitHub as a **GitHub App**. That is a deliberate choice over a personal access token, and it is worth understanding what it buys:',
        },
        {
          k: 'dl',
          items: [
            {
              term: 'Repository-scoped, not account-scoped',
              text: 'The installation covers the repositories you selected. A PAT carries whatever its owner can reach.',
            },
            {
              term: 'Tokens that expire within the hour',
              text: 'Installation tokens are minted per operation and are short-lived, so a leaked token has a small blast radius.',
            },
            {
              term: 'Three permissions, not a checklist',
              text: '`contents:write` to push a branch, `pull_requests:write` to open the pull request, `metadata:read` because GitHub requires it. Nothing else is requested.',
            },
            {
              term: 'It is not tied to a person',
              text: 'A PAT stops working when its owner leaves. An App installation belongs to the organisation.',
            },
          ],
        },
        {
          k: 'p',
          text: 'With the API running, registering the App is one click:',
        },
        {
          k: 'code',
          caption: 'terminal',
          code: `open http://localhost:4000/api/github/app/register`,
        },
        {
          k: 'p',
          text: 'The full walkthrough, including the by-hand path and local webhook delivery, is in [GitHub](/docs/github).',
        },
        { k: 'h2', text: 'GitLab' },
        {
          k: 'p',
          text: 'gitlab.com and self-managed, connected with a personal or group access token — GitLab has nothing App-shaped to install. Same adapter interface, same branch-and-merge-request write path, and the same fail-closed webhook rule using the mechanism GitLab actually offers (token echo, compared in constant time). See [GitLab](/docs/gitlab).',
        },
        { k: 'h2', text: 'What connecting does not do' },
        {
          k: 'ul',
          items: [
            'It does not clone your repository into specd\'s storage. There is no copy to leak.',
            'It does not grant push access to a default branch. Agents open pull requests; they never push to `main`.',
            'It does not start anything. Grounding is the next station, and you trigger it.',
          ],
        },
        {
          k: 'note',
          tone: 'good',
          title: 'Credentials are held with envelope encryption',
          text: 'Every connection secret — a GitLab token, a Jira API token, a model key — is encrypted with a project-bound key, never logged, and verified against the provider before it is stored, so a bad credential fails in front of you rather than later inside an agent run.',
        },
        { k: 'h2', text: 'Merging is adopting' },
        {
          k: 'p',
          text: 'Once a repository is connected, merges are the events specd listens for. The setup branch merged means adoption recorded and `knowledge/` indexed; a `spec/…` branch merged means the spec is delivered and re-indexed; anything touching `knowledge/` on the default branch triggers a re-index. Closing a pull request without merging changes nothing, on purpose.',
        },
      ],
    },

    {
      slug: 'ground-your-repository',
      title: 'Ground your repository',
      summary:
        'What the onboarding scan reads, what it writes, and how to review the setup pull request properly — the highest-leverage review in the whole product.',
      audience: 'everyone',
      minutes: 8,
      blocks: [
        {
          k: 'lead',
          text: 'Grounding is the station that decides how good every later spec can be. Everything downstream cites what lands here, so this is the one pull request worth reading line by line.',
        },
        { k: 'h2', text: 'What the scan reads' },
        {
          k: 'p',
          text: 'It reads the repository the way a new engineer would, starting with the files that state facts rather than opinions:',
        },
        {
          k: 'ul',
          items: [
            '**Manifests** — `package.json`, `go.mod`, `pyproject.toml`, workspace files: what this is built with, and what the commands are.',
            '**CI workflows** — the pipeline that actually gates merges, which is the most reliable statement of "how we verify" any repository contains.',
            '**Compose files and Dockerfiles** — the services the thing needs to run.',
            '**`.env.example`** — the configuration surface, named and described by whoever wrote it.',
            '**Schemas and migrations** — the entities, and their real names.',
            '**Workspace layout** — where the modules are and how they depend on each other.',
          ],
        },
        { k: 'h2', text: 'What it writes' },
        {
          k: 'p',
          text: 'A setup branch and a pull request containing two things: `AGENTS.md` at the root, and a `knowledge/` tree. The content splits cleanly into two halves, and the split is the thing to understand before reviewing.',
        },
        {
          k: 'table',
          head: ['Half', 'What it is', 'How to review it'],
          rows: [
            [
              'The scanned half',
              'Tables of commands, pipelines, services, configuration and entities — **quoted from the files they name**.',
              'Spot-check a row against its source file. It should be a quote, not a paraphrase.',
            ],
            [
              'The drafted half',
              'The judgement around the tables: what the architecture means, why it is shaped this way.',
              'Read it as a first draft by someone who read your repo this morning. Correct it freely — that is what it is for.',
            ],
            [
              '`UNVERIFIED` markers',
              'Everything the scan could not ground.',
              'Each is a question. Answer the ones you can; leave the rest as open questions.',
            ],
          ],
        },
        {
          k: 'note',
          tone: 'rule',
          title: 'The wizard does not pretend to know your architecture',
          text: 'A generated knowledge base that quietly guessed would be worse than none — it would be cited, confidently, for months. So the scan quotes what it can prove and marks what it cannot. This is recorded as a decision in this repository at `knowledge/decisions/0015-onboarding-reads-the-repo-before-it-drafts.md`.',
        },
        { k: 'h2', text: 'Reviewing the setup pull request' },
        {
          k: 'steps',
          items: [
            {
              title: 'Check the commands table first',
              text: 'If the "verify before PR" command is wrong, the build station will run the wrong thing on every future spec. This single row is worth more than the rest of the review.',
            },
            {
              title: 'Read `architecture.md` as a stranger would',
              text: 'The question is not "is this how I would describe it" but "would someone who had never seen this repo be misled". Fix the misleading parts; leave the merely terse ones.',
            },
            {
              title: 'Sweep the `UNVERIFIED` markers',
              text: 'Answer what you know, in the same pull request. Move the rest into `knowledge/open-questions.md` so they are tracked rather than lost.',
            },
            {
              title: 'Read `AGENTS.md` and agree to it',
              text: 'It is your team\'s working agreement with every agent that touches the repo. If a rule does not fit how you work, change it now — it is your file, in your repo.',
            },
            {
              title: 'Merge',
              text: 'Merging is adoption. specd indexes `knowledge/` the moment the webhook lands.',
            },
          ],
        },
        { k: 'h2', text: 'Without a model credential' },
        {
          k: 'p',
          text: 'Grounding still runs, and still produces something useful. The **scanned half** — commands, CI, services, configuration, entities, test layout — is written without a model at all. The judgement sections are left carrying the question they exist to answer instead of being filled in with plausible prose.',
        },
        { k: 'h2', text: 'Grounding is a queued job' },
        {
          k: 'p',
          text: 'A grounding run is a queued row, claimed by whatever will execute it — the server, or a paired runner if the project is in subscription mode. A run whose executor dies is failed rather than left spinning, and the run log streams live in the app while it works.',
        },
        { k: 'h2', text: 'Re-grounding later' },
        {
          k: 'p',
          text: 'You can ground again — after a large refactor, or when adding a second repository to the project. It is a one-per-repo investment: spend properly on the first review, because every spec afterwards cites it. Grounding never overwrites your edits silently; it proposes, and you review the same way you did the first time.',
        },
      ],
    },

    {
      slug: 'review-and-approve',
      title: 'Reviewing and approving a spec',
      summary:
        'A reviewer\'s checklist: what to read first, which three failure modes to watch for, and what your approval actually commits you to.',
      audience: 'everyone',
      minutes: 7,
      blocks: [
        {
          k: 'lead',
          text: 'You are the gate. This page is what to do when a spec lands in your queue — in the order that catches the most, soonest.',
        },
        { k: 'h2', text: 'The checklist, in order' },
        {
          k: 'steps',
          items: [
            {
              title: '1 · Read the requirements and ignore everything else',
              text: 'Ask one question: _if exactly these criteria were satisfied, would the ticket be done?_ If the answer is no, stop. Nothing below this matters, because the design is a solution to the wrong problem.',
            },
            {
              title: '2 · Look for the requirement that is missing',
              text: 'Drafted requirements are usually right about what was said and thin about what was assumed. Error paths, empty states, permissions and migration of existing data are where the gap normally is.',
            },
            {
              title: '3 · Follow two or three citations',
              text: 'Click them. You are not auditing all of them — you are testing whether the citations in this spec are real. If two resolve and say what the claim says, the rest probably do too. If one does not, read the whole design differently.',
            },
            {
              title: '4 · Read every `UNVERIFIED` claim',
              text: 'Each one is a decision being handed to you. Answer it, or send the spec back. Approving a spec with an unanswered `UNVERIFIED` is approving a guess you have agreed to be surprised by.',
            },
            {
              title: '5 · Check each task is genuinely one pull request',
              text: 'A task that is really three is where build runs go wrong: the commits stop mapping to reviewable units and the pull request becomes the diff you were trying to avoid reading.',
            },
            {
              title: '6 · Approve, or ask for v2',
              text: 'Approval pins your name to this version. A revision is cheap — it is a new version, and v1 keeps its record.',
            },
          ],
        },
        { k: 'h2', text: 'Three failure modes worth naming' },
        {
          k: 'dl',
          items: [
            {
              term: 'The plausible design',
              text: 'Well-written, internally consistent, and grounded in nothing. The tell is citation density: a design section with almost no citations is a design section the agent wrote from general knowledge of software rather than from _your_ software.',
            },
            {
              term: 'The requirement that restates the ticket',
              text: '"The system shall let the user export the report" is a title, not a criterion. A real criterion says when, in what format, and what happens when it fails.',
            },
            {
              term: 'The rubber stamp',
              text: 'Four specs approved in ninety seconds. This is the exact failure the station exists to prevent, and the only defence is a named owner with time to do it.',
            },
          ],
        },
        {
          k: 'note',
          tone: 'warn',
          title: 'A `stale` verdict is not a small problem',
          text: 'It means the cited passage is real but describes code that has since changed. The claim may still be true, but nobody has checked — and the doc it rests on is now known to be behind. Read the code before you approve that claim.',
        },
        { k: 'h2', text: 'What your approval commits you to' },
        {
          k: 'ul',
          items: [
            'It records **you**, by name, against **this version**, with a timestamp — permanently, and append-only.',
            'It unlocks the build station for this spec and nothing else.',
            'It is re-checked at the point of use: if the spec is superseded, the build of the old version does not quietly proceed.',
          ],
        },
        {
          k: 'p',
          text: 'The enforcement mechanics are in [The human gate](/docs/the-human-gate).',
        },
        { k: 'h2', text: 'Reviewing outside the app' },
        {
          k: 'p',
          text: 'The spec is fetchable as markdown once approved, which is useful for reading in an editor or attaching to a ticket:',
        },
        {
          k: 'code',
          caption: 'terminal',
          code: `specd spec pull CRM-131        # markdown, approved specs only
specd spec status CRM-131      # exit 0 approved · exit 3 not approved`,
        },
        {
          k: 'p',
          text: 'Note the direction: the CLI can read an approved spec, and cannot approve one. That refusal is server-side, so it holds regardless of what the binary asks for.',
        },
      ],
    },

    {
      slug: 'build-and-ship',
      title: 'Build and ship',
      summary:
        'What the build station does with an approved spec, the three guarantees it enforces, and how to read the result.',
      audience: 'engineering',
      minutes: 7,
      blocks: [
        {
          k: 'lead',
          text: 'The build station takes an approved spec and produces a pull request. Everything it is not allowed to do is enforced rather than requested.',
        },
        { k: 'h2', text: 'Starting a build' },
        {
          k: 'p',
          text: 'From the spec drawer in the app, or over the API:',
        },
        {
          k: 'code',
          caption: 'HTTP',
          code: `POST /projects/:slug/board/specs/:specId/build`,
        },
        { k: 'h2', text: 'The three guarantees' },
        {
          k: 'dl',
          items: [
            {
              term: 'The gate is re-checked at the point of use',
              text: 'Not consulted once at dispatch and trusted afterwards. An unapproved spec gets the same 409 the CLI gets, at the moment agent output would first reach code.',
            },
            {
              term: 'The agent gets editing tools only — never a shell',
              text: 'It cannot run arbitrary commands. specd runs your repository\'s own verify command itself, so "the tests passed" is a statement specd made, not one the agent reported about itself.',
            },
            {
              term: 'It never touches your working tree',
              text: 'Local builds use a throwaway git worktree; hosted builds use a shallow clone in a scratch directory. The branch survives; the workspace does not. You can keep working while a build runs.',
            },
          ],
        },
        { k: 'h2', text: 'What comes out' },
        {
          k: 'ul',
          items: [
            'A branch named `spec/<ID>-<slug>`, cut fresh from your default branch every run — which is also how the merge webhook matches the delivery back to the spec.',
            'One commit per task, in the order the spec listed them.',
            'A pull request (or merge request) titled `[<ID>] - <Title>`, for you to review and merge. specd never merges.',
            'The as-built spec, filed into `knowledge/specs/` by the last task — and appended by specd itself if the model omitted it.',
          ],
        },
        {
          k: 'note',
          tone: 'rule',
          title: 'The as-built record is written by specd, not by the model',
          text: 'It is a verbatim copy of what was approved. A model-composed summary of its own work is a summary with an interest in the outcome.',
        },
        { k: 'h2', text: 'Reading the verify result' },
        {
          k: 'p',
          text: 'Verification distinguishes two outcomes that are usually collapsed into one — and they belong to different people:',
        },
        {
          k: 'table',
          head: ['Result', 'Means', 'Whose problem'],
          rows: [
            ['**failed**', 'Your tests ran, and did not pass.', 'The change is wrong. Read the diff.'],
            [
              '**could not run**',
              'The toolchain was missing, so nothing was proved either way.',
              'The environment is wrong. Fix the runner or the image.',
            ],
            ['**passed**', 'Your repository\'s own verify command exited zero.', 'Review the pull request as normal.'],
          ],
        },
        { k: 'h2', text: 'Where the build runs' },
        {
          k: 'p',
          text: 'On the server, or on a **paired runner** — a machine of yours that claims jobs and drives its own local Claude Code. The runner path matters for builds specifically: a dispatched build clones and pushes with **the runner machine\'s own git credentials**. specd sends no VCS token, and push access is checked before the first model call rather than discovered at the end of an expensive run. See [Self-hosted runners](/docs/self-hosted-runners).',
        },
        { k: 'h2', text: 'Building from your own agent instead' },
        {
          k: 'p',
          text: 'You do not have to use the build station. Pull the approved spec and hand it to whatever agent you already use:',
        },
        {
          k: 'code',
          caption: 'terminal',
          code: `specd spec pull CRM-131 > spec.md   # approved only — the gate is server-side`,
        },
        {
          k: 'p',
          text: 'If that agent is Claude Code, the [plugin](/docs/agent-integrations) does the same thing with the gate checked automatically, plus a hook that blocks edits on a spec branch whose spec is not approved.',
        },
      ],
    },

    {
      slug: 'bring-your-own-model',
      title: 'Bring your own model',
      summary:
        'Three ways to give specd a model — your Claude subscription, an API key, or neither — and what each one costs you in capability.',
      audience: 'engineering',
      minutes: 7,
      blocks: [
        {
          k: 'lead',
          text: 'specd does not resell inference. You supply the model, and the wizard preflights which of the three modes this machine can actually do.',
        },
        { k: 'h2', text: '1 · Your Claude subscription — no API key' },
        {
          k: 'p',
          text: 'specd drives the Claude Code CLI that is already signed in on the machine.',
        },
        { k: 'code', caption: 'terminal', code: `export SPECD_AI_MODE=subscription_runner` },
        {
          k: 'note',
          tone: 'rule',
          title: 'The constraint is the architecture, not a limitation',
          text: 'specd never sees, stores or proxies a subscription credential — it shells out to a CLI that is already logged in. That is also exactly why a _hosted_ specd could not offer this mode at all: there is no machine to already be signed in on.',
        },
        {
          k: 'ul',
          items: [
            'Runs consume your subscription quota, so they record tokens but are **not metered in euros**.',
            'The reply has no schema guarantee, so it is shape-checked with one repair attempt before giving up — rather than being trusted and failing later.',
            'Pairs naturally with [self-hosted runners](/docs/self-hosted-runners): the runner is the machine that is signed in.',
          ],
        },
        { k: 'h2', text: '2 · An API key' },
        {
          k: 'p',
          text: 'Works from anywhere, is schema-enforced, and is metered per token from a rate card.',
        },
        { k: 'code', caption: 'terminal', code: `export ANTHROPIC_API_KEY=sk-ant-...` },
        {
          k: 'p',
          text: 'Money is integer EUR cents throughout — floats never touch it. Spend caps are checked **before** a run starts, not after it has already cost something. See [Costs and metering](/docs/costs-and-metering).',
        },
        { k: 'h2', text: '3 · Neither' },
        {
          k: 'p',
          text: 'specd still runs end to end. What you lose is precisely the drafting, and nothing else:',
        },
        {
          k: 'table',
          head: ['Works without a model', 'Needs a model'],
          rows: [
            ['Indexing, retrieval, the document graph', 'Drafting a spec'],
            ['Knowledge health, coupling, freshness', 'The judgement half of grounding'],
            ['The scanned half of grounding — commands, CI, services, configuration, entities, test layout', 'The build station'],
            ['The CLI, MCP, `verify_citation`, the gate', '—'],
          ],
        },
        {
          k: 'note',
          tone: 'good',
          title: 'It fails loudly, not quietly',
          text: 'Spec generation without a credential fails with a clear error rather than inventing content. The health endpoint reports `"ai": "no platform key (BYO key per project)"` — which is a normal, honest state, not a warning.',
        },
        { k: 'h2', text: 'Embeddings are a separate choice' },
        {
          k: 'p',
          text: 'The default embedder is a deterministic local hash: no second API key, works offline. The README-level truth about it is that it is **lexical** — the full-text arm of retrieval carries relevance until you point the index at a real model. Two ways to do that:',
        },
        {
          k: 'code',
          caption: 'terminal',
          code: `# hosted
SPECD_EMBEDDING_PROVIDER=voyage   VOYAGE_API_KEY=...

# any OpenAI-compatible /v1/embeddings endpoint — Ollama, LM Studio,
# llama.cpp, vLLM
SPECD_EMBEDDING_PROVIDER=openai   SPECD_EMBEDDING_BASE_URL=http://localhost:11434/v1`,
        },
        {
          k: 'p',
          text: 'The second option is the interesting one: the retrieval ceiling comes off **without a cloud key and without a repository\'s knowledge leaving the machine**.',
        },
        {
          k: 'note',
          tone: 'warn',
          title: 'The model must produce 1024-dimension vectors',
          text: 'That is the width of the pgvector column. The API probes the endpoint at startup and refuses a mismatch by name, rather than failing on an insert halfway through the first index run. Changing embedder also re-embeds unchanged documents on purpose — two vector spaces in one index is incoherence, not staleness.',
        },
        { k: 'h2', text: 'Checking what this machine can do' },
        { k: 'code', caption: 'terminal', code: `specd doctor          # or --json, for CI` },
        {
          k: 'p',
          text: 'It reports config, server, database, embeddings, AI credential, identity and default project in dependency order, and skips what an earlier failure makes unknowable. Optional configuration is a note, never a fault: no platform key, no default project and the built-in embedder are all supported ways to run specd. Exit 4 means something needs fixing.',
        },
      ],
    },

    {
      slug: 'agent-integrations',
      title: 'Agent integrations',
      summary:
        'Serve the knowledge base to Claude Code, Cursor or Windsurf over MCP, and install the plugin that makes the working agreements bind.',
      audience: 'engineering',
      minutes: 8,
      blocks: [
        {
          k: 'lead',
          text: 'The knowledge base is most useful inside the editor where the work happens. Two integrations put it there — one read-only for any MCP client, one Claude Code-specific that enforces two of the working agreements.',
        },
        { k: 'h2', text: 'MCP — ask the knowledge base instead of grepping' },
        {
          k: 'p',
          text: '`specd mcp serve` puts the retrieval engine behind the Model Context Protocol, so an agent in Claude Code, Cursor, Windsurf or anything else that speaks it can query the knowledge base directly.',
        },
        {
          k: 'code',
          caption: '.mcp.json — or your editor\'s MCP settings',
          code: `{
  "mcpServers": {
    "specd": { "command": "specd", "args": ["mcp", "serve"] }
  }
}`,
        },
        {
          k: 'p',
          text: 'Needs the `specd` CLI on your PATH and `specd login` once per machine. Seven tools and three ambient resources; the full signatures are in [MCP tools](/docs/mcp).',
        },
        {
          k: 'note',
          tone: 'good',
          title: 'Search results carry the string to cite them by',
          text: 'A grep gets you the text and none of the evidence. `search_knowledge` returns the passage **and** the exact `CITE-AS` string a design claim should use, plus how the passage was found — a direct match, a graph expansion (naming the edge that pulled it in), or source code a document references.',
        },
        {
          k: 'note',
          tone: 'rule',
          title: 'Read-only by construction, not by convention',
          text: 'The server carries the same CLI-audience token as every other command, and the API refuses those tokens on every route that is not explicitly CLI-allowed. Approving a spec through it is not blocked — it is impossible.',
        },
        { k: 'h2', text: 'The Claude Code plugin' },
        {
          k: 'p',
          text: '`AGENTS.md` is a numbered list of rules, and three of them are already enforced by software: the server refuses to serve an unapproved spec, the webhook matches merged `spec/<ID>-<slug>` branches back to their spec, and the build station files the as-built record itself. The rest were enforced by asking nicely. The plugin makes two more bind at the moment they are broken.',
        },
        {
          k: 'p',
          text: 'Install it from this repository, which is its own marketplace:',
        },
        {
          k: 'code',
          caption: 'in Claude Code',
          code: `/plugin marketplace add unitypark/specd
/plugin install specd@specd`,
        },
        {
          k: 'table',
          head: ['Command', 'What it does'],
          rows: [
            [
              '`/specd:pull <id>`',
              'Gate first, then the knowledge the design cites, then the branch.',
            ],
            ['`/specd:implement`', 'Tasks in order, one commit each, verify between them.'],
            [
              '`/specd:as-built`',
              'Files the record — copied from the approved spec, never composed.',
            ],
          ],
        },
        { k: 'h3', text: 'The two hooks' },
        {
          k: 'dl',
          items: [
            {
              term: '`gate.sh`',
              text: 'Blocks an edit on a `spec/` branch whose spec is not approved. It fails **open** on every infrastructure problem — no CLI, not logged in, server unreachable — because a hook that blocks all editing when the API is down is a hook people uninstall.',
            },
            {
              term: '`docs-ride-the-change.sh`',
              text: 'Asks once, when a spec branch has changed code and nothing under `knowledge/`, whether rule 3 was met. It asks; it does not decide.',
            },
          ],
        },
        {
          k: 'p',
          text: 'Neither can approve anything. That is a signed-in human in the app, and the reasoning is recorded at `knowledge/decisions/0018-working-agreements-ship-as-a-plugin.md`.',
        },
        { k: 'h2', text: 'Using specd from CI' },
        {
          k: 'p',
          text: 'The CLI is a single static Go binary, which makes it a reasonable thing to put in a pipeline. The gate is available as an exit code:',
        },
        {
          k: 'code',
          caption: 'terminal',
          code: `specd spec status "$SPEC_ID"
# 0 approved · 1 error · 2 usage · 3 exists but not approved`,
        },
        {
          k: 'p',
          text: 'Set `SPECD_TOKEN` for a non-interactive session and `SPECD_PROJECT` to skip `specd use`. Full list in [Configuration](/docs/configuration).',
        },
      ],
    },
  ],
};
