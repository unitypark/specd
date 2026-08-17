import type { DocCategory } from './types';

/*
 * Reference — the pages people arrive at from a search engine with a specific
 * question. Written to be scanned rather than read: tables first, prose only
 * where the reason for a value is the useful part.
 */
export const REFERENCE: DocCategory = {
  title: 'Reference',
  blurb: 'The CLI, the MCP surface, configuration, and how the engine works.',
  pages: [
    {
      slug: 'cli',
      title: 'CLI reference',
      summary:
        'Every `specd` command, the exit codes worth scripting against, the environment overrides, and the interactive shell.',
      audience: 'engineering',
      minutes: 8,
      blocks: [
        {
          k: 'lead',
          text: 'A single static Go binary. It fetches, registers and reports — it never authors, reviews or approves, and the server refuses those for CLI tokens regardless of what the binary asks.',
        },
        { k: 'h2', text: 'Install' },
        {
          k: 'code',
          caption: 'from the repository',
          code: `pnpm cli:build      # → ./bin/specd
pnpm cli:install    # → $(go env GOPATH)/bin/specd — warns if that is not on PATH`,
        },
        { k: 'h2', text: 'Commands' },
        {
          k: 'table',
          head: ['Command', 'What it does'],
          rows: [
            ['`specd login`', 'Device flow — a human confirms in the browser. The token lands in your OS keychain.'],
            ['`specd logout`', 'Drops the stored token.'],
            ['`specd whoami`', 'Who this machine is signed in as.'],
            ['`specd projects`', 'Projects this account can see.'],
            ['`specd use <project>`', 'Set the default project for this machine.'],
            ['`specd spec pull <id>`', 'Print an approved spec as markdown. Refused server-side for anything unapproved.'],
            ['`specd spec status <id>`', 'Lifecycle state. **Exit 3** when the spec exists but is not approved.'],
            ['`specd specs list --status approved`', 'List specs, filterable by lifecycle state.'],
            ['`specd connect .`', 'Register a local repository. Code stays on your machine.'],
            ['`specd runner pair <code>`', 'Pair this machine as a self-hosted runner. Codes are single-use and expire in 30 minutes.'],
            ['`specd runner token`', 'Print this machine\'s runner token — for the daemon\'s environment.'],
            ['`specd open <id>`', 'Open the spec (or the project) in the web app.'],
            ['`specd doctor`', 'Check the whole setup in dependency order. `--json` for CI.'],
            ['`specd mcp serve`', 'Serve the knowledge base over MCP. See [MCP tools](/docs/mcp).'],
          ],
        },
        { k: 'h2', text: 'Exit codes' },
        {
          k: 'p',
          text: 'Deliberately distinct, so a pipeline can gate on approval rather than on "something went wrong".',
        },
        {
          k: 'table',
          head: ['Code', 'Means'],
          rows: [
            ['`0`', 'Fine.'],
            ['`1`', 'Error.'],
            ['`2`', 'Usage.'],
            ['`3`', '**Exists, but not approved.**'],
            ['`4`', '`doctor` only — something needs fixing.'],
          ],
        },
        {
          k: 'code',
          caption: 'gating CI on the human gate',
          code: `- name: Require an approved spec
  run: |
    specd spec status "$SPEC_ID"
    case $? in
      0) echo "approved — building" ;;
      3) echo "::error::$SPEC_ID is not approved yet"; exit 1 ;;
      *) echo "::error::could not reach specd"; exit 1 ;;
    esac`,
        },
        { k: 'h2', text: 'Environment' },
        {
          k: 'table',
          head: ['Variable', 'Purpose'],
          rows: [
            ['`SPECD_API`', 'API base URL. Default `http://localhost:4000/api`.'],
            ['`SPECD_PROJECT`', 'Default project slug, overriding `specd use`.'],
            ['`SPECD_TOKEN`', 'Token override — for CI.'],
            ['`SPECD_WEB`', 'Web origin, used by `specd open`.'],
            ['`SPECD_RUNNER_TOKEN`', 'Runner token override.'],
          ],
        },
        { k: 'h2', text: 'The interactive shell' },
        {
          k: 'p',
          text: 'Run `specd` with no arguments **at a TTY** and you get an interactive shell: type `/` to see every command, keep typing to narrow by prefix, ↑/↓ to move, Enter to run. A command needing an argument you did not supply prompts for it rather than failing silently.',
        },
        {
          k: 'note',
          tone: 'good',
          title: 'Scripts and CI are untouched',
          text: '`specd` with no arguments and a non-terminal stdin still prints usage and exits `2`, exactly as before. The shell only ever starts in a real TTY, so it cannot surprise a pipeline.',
        },
        {
          k: 'p',
          text: 'Every slash command is a thin adapter over the same function the flag-based path calls — same config loading, same errors, same behaviour. `/status` is deliberately **not** `spec status <id>`: it reports CLI version, connected project and auth state, while a spec\'s lifecycle stays at `/spec-status <id>`. Full mapping in `docs/cli-repl.md`.',
        },
        { k: 'h2', text: '`specd doctor`' },
        {
          k: 'p',
          text: 'specd is several services at once — an API, Postgres with an extension, a vault key, a web app on another origin, an optional model provider, an optional embedder, an optional paired runner. When it does not work, the failure usually surfaces as whatever broke first rather than as the cause.',
        },
        {
          k: 'p',
          text: '`doctor` reports config, server, database, embeddings, AI credential, identity and default project **in dependency order**, and skips what an earlier failure makes unknowable rather than piling on: one broken thing reads as one broken thing. Optional configuration is reported as a note, never a fault — no platform key, no default project and the built-in embedder are all supported ways to run specd, and the embedder note names the retrieval ceiling honestly and says how to lift it.',
        },
      ],
    },

    {
      slug: 'mcp',
      title: 'MCP tools',
      summary:
        'The seven tools and three resources `specd mcp serve` exposes, and what makes the surface read-only by construction.',
      audience: 'engineering',
      minutes: 6,
      blocks: [
        {
          k: 'lead',
          text: 'An agent that can query the knowledge base does not have to grep for it — and gets the citation string along with the passage, already checked.',
        },
        { k: 'h2', text: 'Wiring it up' },
        {
          k: 'code',
          caption: '.mcp.json',
          code: `{
  "mcpServers": {
    "specd": { "command": "specd", "args": ["mcp", "serve"] }
  }
}`,
        },
        {
          k: 'p',
          text: 'Needs the `specd` CLI on your PATH and `specd login` once per machine. Works with any MCP-capable client — Claude Code, Cursor, Windsurf.',
        },
        { k: 'h2', text: 'Tools' },
        {
          k: 'table',
          head: ['Tool', 'What it answers'],
          rows: [
            [
              '`search_knowledge`',
              'Passages matching a question, each with the exact `CITE-AS` string to cite it by and how it was found.',
            ],
            ['`get_doc`', 'A whole document by path.'],
            [
              '`verify_citation`',
              'Is this citation `supported`, `stale`, `unsupported` or `unknown`? Same function the SpecAgent uses.',
            ],
            ['`knowledge_health`', 'Broken links, dangling anchors, orphans, stale code references, and the score.'],
            ['`spec_status`', 'A spec\'s lifecycle state — including whether it is approved.'],
            ['`spec_pull`', 'An approved spec as markdown. Unapproved specs are refused server-side.'],
            ['`list_specs`', 'Specs, filterable by lifecycle state.'],
          ],
        },
        { k: 'h2', text: 'Resources' },
        {
          k: 'p',
          text: 'Ambient state an agent can keep in view without asking:',
        },
        {
          k: 'dl',
          items: [
            { term: '`specd://knowledge/health`', text: 'The current health of the project\'s knowledge base.' },
            { term: '`specd://specs/awaiting-review`', text: 'What is sitting at the gate right now.' },
            { term: '`specd://project/summary`', text: 'What this project is, and what it is connected to.' },
          ],
        },
        { k: 'h2', text: 'Why the results are citable' },
        {
          k: 'p',
          text: 'Every search result carries three things: the passage, the `CITE-AS` string a design claim should use, and **how the passage was found** — a direct match, a graph expansion (naming the edge that pulled it in), or source code a document references.',
        },
        {
          k: 'quote',
          text: 'Grepping gets you the text and none of the evidence.',
        },
        {
          k: 'p',
          text: '`verify_citation` returns the same four verdicts the SpecAgent uses, from the same function. A citation that is `supported` in a spec and `unsupported` when anyone checks it would make the verdict worthless.',
        },
        { k: 'h2', text: 'Read-only, by construction' },
        {
          k: 'note',
          tone: 'rule',
          title: 'Approving through MCP is not blocked — it is impossible',
          text: 'The server carries the same CLI-audience token as every other command, and the API refuses those tokens on every route that is not explicitly CLI-allowed. There is no "write mode" flag to leave on by accident, because there is no write mode.',
        },
        {
          k: 'p',
          text: 'The reasoning is recorded at `knowledge/decisions/0017-the-engine-answers-over-mcp.md`.',
        },
      ],
    },

    {
      slug: 'configuration',
      title: 'Configuration',
      summary:
        'Every environment variable specd reads, what it defaults to, and which ones fail closed.',
      audience: 'engineering',
      minutes: 7,
      blocks: [
        {
          k: 'lead',
          text: 'Configuration lives in a repo-root `.env`. The API, the migration runner and Next.js each load it themselves — nothing needs sourcing into your shell.',
        },
        {
          k: 'note',
          tone: 'info',
          title: '`.env.example` is the canonical list',
          text: 'It ships with dev defaults that work as-is, and every value you would change for a real environment is commented with what it does and how to generate it. This page is the same list, grouped.',
        },
        { k: 'h2', text: 'Core' },
        {
          k: 'table',
          head: ['Variable', 'Notes'],
          rows: [
            ['`DATABASE_URL`', 'Postgres with the `vector` extension. docker-compose maps host **5433** to avoid clashing with a local Postgres on 5432.'],
            ['`PORT`', 'API port. Default `4000`.'],
            ['`API_PUBLIC_URL`', 'How the outside world reaches the API — used for webhook URLs and the App registration flow.'],
            ['`WEB_ORIGIN`', 'Origin of the web app, for CORS and links.'],
            ['`JWT_SECRET`', 'Session signing. **Change it in any non-local environment.**'],
            ['`VAULT_MASTER_KEY`', '32-byte master key for the credential vault (envelope encryption). Generate with `openssl rand -base64 32`.'],
          ],
        },
        {
          k: 'note',
          tone: 'warn',
          title: '`NODE_ENV` is deliberately not in `.env`',
          text: 'The tooling sets it per command. A `source .env` before `pnpm build` would otherwise pin a production build to development mode.',
        },
        { k: 'h2', text: 'AI' },
        {
          k: 'table',
          head: ['Variable', 'Notes'],
          rows: [
            ['`ANTHROPIC_API_KEY`', 'Optional. Without it the platform still runs; agent runs fail with a clear, honest error.'],
            ['`SPECD_DEFAULT_MODEL`', 'Platform default. Allowlist: `claude-opus-5` · `claude-sonnet-5` · `claude-haiku-4-5`.'],
            ['`SPECD_AI_MODE`', 'Set to `subscription_runner` to drive the locally signed-in Claude Code CLI instead of an API key.'],
            ['`SPECD_USD_TO_EUR`', 'EUR per USD, used to meter run cost from the model\'s USD rates.'],
          ],
        },
        { k: 'h2', text: 'Knowledge index' },
        {
          k: 'table',
          head: ['Variable', 'Notes'],
          rows: [
            [
              '`SPECD_EMBEDDING_PROVIDER`',
              '`hash` (default — deterministic, offline, lexical), `voyage`, or `openai` for any OpenAI-compatible `/v1/embeddings` endpoint.',
            ],
            ['`VOYAGE_API_KEY`', 'Required by `voyage`. The API refuses to start without it rather than falling back to `hash` behind your back.'],
            ['`SPECD_EMBEDDING_BASE_URL`', 'For `openai` — e.g. `http://localhost:11434/v1` for Ollama.'],
            ['`SPECD_EMBEDDING_MODEL`', 'Must produce **1024-dimension** vectors. `mxbai-embed-large` fits; `nomic-embed-text` is 768 and is refused.'],
            ['`SPECD_EMBEDDING_API_KEY`', 'For endpoints that need one.'],
          ],
        },
        {
          k: 'note',
          tone: 'warn',
          title: 'Switching provider re-embeds everything',
          text: 'On purpose. Two providers produce different vector spaces, and mixing them makes distances meaningless — that is incoherence, not staleness. The API probes the endpoint at startup and refuses a dimension mismatch **by name**, rather than failing on an insert halfway through the first index run.',
        },
        { k: 'h2', text: 'VCS' },
        {
          k: 'table',
          head: ['Variable', 'Notes'],
          rows: [
            ['`SPECD_LOCAL_REPO_ROOT`', 'Root the local-git adapter may touch. Repos registered via `specd connect` must live under it.'],
            ['`SPECD_LOCAL_OPEN_PR`', 'Default `1`. May a local-mode branch be pushed to its own `origin` and opened as a PR/MR with the `gh`/`glab` signed in on this machine? Set `0` for a machine with a remote it must not publish to — the branch is still committed locally.'],
            ['`GITHUB_APP_ID` · `GITHUB_APP_SLUG` · `GITHUB_APP_PRIVATE_KEY`', 'From the App GitHub generated. Real newlines or `\\n` escapes both work.'],
            ['`GITHUB_WEBHOOK_SECRET`', 'Required for webhooks. **Empty rejects every delivery** — it never means "skip the signature check".'],
            ['`GITLAB_WEBHOOK_SECRET`', 'Same rule, same reason.'],
            ['`GITHUB_API_BASE` · `GITHUB_BASE` · `GITHUB_CLONE_BASE`', 'GitHub Enterprise Server only.'],
            ['`SPECD_BUILD_ROOT`', 'Scratch root for hosted build clones. Each run gets its own directory and deletes it afterwards. Defaults to the system temp dir.'],
          ],
        },
        {
          k: 'note',
          tone: 'rule',
          title: 'Unset must never mean "skip it"',
          text: 'Both webhook secrets fail **closed**. A forgotten value cannot open a hole — it can only stop deliveries, which is loud and fixable, rather than accepting forged ones, which is silent and not.',
        },
        { k: 'h2', text: 'Workers and retention' },
        {
          k: 'table',
          head: ['Variable', 'Default', 'Notes'],
          rows: [
            ['`SPECD_INDEX_WORKER_ENABLED`', '`true`', 'The in-process index worker.'],
            ['`SPECD_INDEX_POLL_MS`', '`60000`', 'A **backstop** for a dropped `LISTEN` connection — not how work normally starts.'],
            ['`SPECD_INDEX_LEASE_SECONDS`', '`900`', 'How long a claimed index run is held.'],
            ['`SPECD_WEBHOOK_RETENTION_DAYS`', '`30`', 'Delivery rows are the audit trail for "why did specd do that last week".'],
            ['`SPECD_WEBHOOK_PRUNE_INTERVAL_MS`', '`86400000`', 'Pruned daily and at startup.'],
            ['`SPECD_RUNNER_LEASE_SECONDS`', '`180`', 'Lease for spec/onboard jobs.'],
            ['`SPECD_RUNNER_LEASE_BUILD_SECONDS`', '`900`', 'Builds legitimately take longer to look alive.'],
            ['`SPECD_RUNNER_MAX_RECLAIMS`', '`3`', 'Then failed as repeatedly abandoned, rather than bouncing forever.'],
            ['`SPECD_RUNNER_POLL_MS`', '`5000`', 'Runner daemon poll interval.'],
          ],
        },
      ],
    },

    {
      slug: 'architecture',
      title: 'Architecture',
      summary:
        'What runs where, why Postgres is the only runtime dependency, and how an index run stays atomic.',
      audience: 'engineering',
      minutes: 9,
      blocks: [
        {
          k: 'lead',
          text: 'Boring on purpose. Postgres is the only runtime service, and the decision that keeps it that way is written down rather than assumed.',
        },
        { k: 'h2', text: 'The pieces' },
        {
          k: 'table',
          head: ['Path', 'What it is'],
          rows: [
            ['`apps/api`', 'NestJS API — auth, projects, pipeline, agents, the knowledge engine.'],
            ['`apps/web`', 'Next.js — landing, wizard, dashboard, board, spec review, knowledge, runs.'],
            ['`apps/runner`', 'The self-hosted daemon that claims and executes jobs.'],
            ['`cli`', '`specd` — Go, a single static binary.'],
            ['`packages/shared`', 'Spec lifecycle, EARS rendering, the model rate card, cost metering.'],
            ['`packages/db`', 'Drizzle schema plus plain-SQL migrations (Postgres + pgvector).'],
            ['`packages/templates`', '`AGENTS.md`, `CLAUDE.md` and the `knowledge/` scaffold.'],
            ['`evals`', 'Quality grading against independent oracles — see [Evals](/docs/evals).'],
          ],
        },
        { k: 'h2', text: 'The data flow' },
        {
          k: 'code',
          caption: 'merge → index → retrieve → draft → gate → build → merge',
          code: `your repository (git = source of truth)
   knowledge/**.md      src/**
        │
        │  merge webhook → queued row + NOTIFY
        ▼
   indexer      chunk · embed · links · symbols · coupling
                one transaction, shrink-guarded
        ▼
   Postgres     docs · chunks · links · code nodes · coupling
        ▼
   retrieval    RRF → doc-graph hop → code snippets
        ▼
   SpecAgent    drafts, cites, four verdicts
        ▼
   [ named human approves ]
        ▼
   build on spec/<ID> branch → PR / MR — you merge
        └──────────────────────────────────────────► back to the webhook`,
        },
        { k: 'h2', text: 'Why Postgres is the only runtime dependency' },
        {
          k: 'p',
          text: 'Index runs are **queued rows woken by Postgres `LISTEN/NOTIFY`** — there is no broker. A webhook returns in the time it takes to write one row; a worker in the API process is woken by the notification and does the work. The poll interval exists only as a backstop for a dropped listen connection.',
        },
        {
          k: 'ul',
          items: [
            'Jobs are claimed with `FOR UPDATE SKIP LOCKED`, so two workers polling the same queue cannot take the same row.',
            'Jobs abandoned by a dead worker are reclaimed by **lease**, not by a heuristic about how long is too long.',
            'Run logs stream live over SSE, across API instances.',
          ],
        },
        {
          k: 'p',
          text: 'The decision to remove the queue that used to sit here is recorded at `knowledge/decisions/0008-remove-unused-queue.md`. One fewer service is one fewer thing to operate, monitor and explain.',
        },
        { k: 'h2', text: 'Indexing is deterministic and atomic' },
        {
          k: 'note',
          tone: 'rule',
          title: 'No model ever runs at index time',
          text: 'Documents are chunked on headings, embedded, and their links extracted with **parser rules** across five deterministic kinds — `citation`, `wikilink`, `symbolref`, `mdlink`, `coderef`. A hallucinated edge would poison retrieval invisibly, and nothing downstream would ever surface it.',
        },
        {
          k: 'p',
          text: 'Every write of an index run lands in one transaction, guarded two ways:',
        },
        {
          k: 'dl',
          items: [
            {
              term: 'A shrink guard',
              text: 'A run that would gut the index is refused — an empty listing against a non-empty index is rejected at any size. A scanner that silently returned nothing must not be able to erase a knowledge base.',
            },
            {
              term: 'A provenance check',
              text: 'A run that drops edges belonging to documents it never touched is rolled back. A run may only affect what it actually read.',
            },
          ],
        },
        {
          k: 'p',
          text: 'What to re-index is decided by a per-document content sha **plus an extractor fingerprint**. Change the chunker or the embedder and unchanged documents re-embed — because two vector spaces in one index is incoherence, not staleness.',
        },
        { k: 'h2', text: 'The code index' },
        {
          k: 'p',
          text: 'specd indexes the repository\'s file tree and its declarations for **TypeScript, Go and Python** — a line-based tier, graded against real compilers (see [Evals](/docs/evals)). That is what makes three things possible:',
        },
        {
          k: 'ol',
          items: [
            'A document citing `RunnerJobsService.claim()` resolves to the real symbol.',
            'Retrieval can serve the function\'s **actual source** as a citable excerpt, fenced in the prompt and cited as `path#Class.method`.',
            'When the code moves on without the document, both the doc\'s health and the spec\'s citation can say so.',
          ],
        },
        { k: 'h2', text: 'Drift is measured against the code' },
        {
          k: 'p',
          text: 'Doc↔code coupling is mined from a bounded window of git history. The signal reads _"6 commits touched `apps/api/src/runners/` since this doc last moved with it"_ — which names the code to go read. A 90-day timer only measures time passing.',
        },
        { k: 'h2', text: 'Stack' },
        {
          k: 'p',
          text: 'Next.js · NestJS · Postgres + pgvector · Anthropic SDK · Go CLI. specd\'s own design notes live in `knowledge/architecture.md`, and every decision behind this page is an ADR under `knowledge/decisions/` — the product eats its own food.',
        },
      ],
    },

    {
      slug: 'retrieval-engine',
      title: 'The retrieval engine',
      summary:
        'Three bounded stages — rank fusion, a graph hop, then real source code — and the honesty rules that stop it overstating what it found.',
      audience: 'engineering',
      minutes: 8,
      blocks: [
        {
          k: 'lead',
          text: 'This is the part of specd that makes the specs worth trusting. It is a knowledge graph, not just a vector store, and every stage is bounded so a prompt cannot quietly fill with noise.',
        },
        { k: 'h2', text: 'Stage 1 · Rank fusion' },
        {
          k: 'p',
          text: 'Reciprocal Rank Fusion over two arms: vector similarity in **pgvector**, and Postgres full-text search over a generated `tsvector`. Merging by rank rather than by score is what lets two incomparable scoring systems vote together.',
        },
        {
          k: 'ul',
          items: [
            '**Headings outrank body text** — a match in a section title is a stronger signal about what a passage is about.',
            '**One document cannot take every slot**, so a long document does not crowd out the corpus.',
          ],
        },
        { k: 'h2', text: 'Stage 2 · One hop across the graph' },
        {
          k: 'p',
          text: 'The seed documents are expanded one hop across **resolved links** — the five deterministic edge kinds extracted at index time. The expansion is edge-kind weighted, hub-gated (so a hub document does not pull in everything), query-ranked, and budgeted at four additions.',
        },
        {
          k: 'note',
          tone: 'good',
          title: 'Every added chunk carries the edge that pulled it in',
          text: 'So a reader can see not just _that_ a passage was included but _why_ — "this arrived via a `citation` edge from architecture.md". Retrieval that cannot explain itself is retrieval you have to trust blindly.',
        },
        { k: 'h2', text: 'Stage 3 · Real source code' },
        {
          k: 'p',
          text: 'Up to two **code snippets**: the actual source of symbols the seed documents reference, read from the repository at retrieval time, fenced in the prompt, and citable as `path#Class.method`. The doc says what the code is for; the code says what it does.',
        },
        { k: 'h2', text: 'Embeddings, and the honest ceiling' },
        {
          k: 'p',
          text: 'The default embedder is a deterministic local hash — no second API key, works offline. The README-level truth about it is that it is **lexical**: the full-text arm carries relevance until you point the index at a real model.',
        },
        {
          k: 'code',
          caption: 'lifting the ceiling',
          code: `SPECD_EMBEDDING_PROVIDER=voyage   VOYAGE_API_KEY=...

# or any OpenAI-compatible /v1/embeddings endpoint —
# Ollama, LM Studio, llama.cpp, vLLM
SPECD_EMBEDDING_PROVIDER=openai   SPECD_EMBEDDING_BASE_URL=http://localhost:11434/v1`,
        },
        {
          k: 'p',
          text: 'The second option is the interesting one: the ceiling comes off **without a cloud key and without a repository\'s knowledge leaving the machine**. Misconfiguring either fails loudly rather than degrading silently — the API probes the endpoint at startup and refuses a dimension mismatch by name.',
        },
        { k: 'h2', text: 'The honesty rules' },
        {
          k: 'p',
          text: 'A retrieval engine that overstates what it found produces specs that overstate what they know. Three rules stop that:',
        },
        {
          k: 'dl',
          items: [
            {
              term: 'Truncation is announced only when real matches were cut',
              text: 'A notice that fires on every request is a notice nobody reads.',
            },
            {
              term: 'Freshness says _unmeasured_, not _fresh_',
              text: 'A document with no commit date has an unknown age. Reporting it as fresh would be inventing a fact.',
            },
            {
              term: '`unknown` is not `unsupported`',
              text: 'The corpus failing to answer and the corpus answering "no" are different results, and only one of them is evidence.',
            },
          ],
        },
        { k: 'h2', text: 'Health as numbers the UI can badge' },
        {
          k: 'p',
          text: 'Broken links, dangling anchors, orphans and stale code references are counted, and they move the score. They are not advisory notes on a page nobody opens — they are the metric that tells you when the corpus your specs rest on has started to rot.',
        },
      ],
    },

    {
      slug: 'security',
      title: 'Security and invariants',
      summary:
        'The nine properties specd enforces in code rather than by convention, and where each one is enforced.',
      audience: 'engineering',
      minutes: 7,
      blocks: [
        {
          k: 'lead',
          text: 'Each of these is enforced in code, and each has a test. A property that depends on everyone remembering it is not a property.',
        },
        { k: 'h2', text: 'The invariants' },
        {
          k: 'dl',
          items: [
            {
              term: 'Only a named human can approve',
              text: 'The state machine refuses `approved` without an actor, and a database CHECK constraint rejects an approved row with no approver — a direct write cannot record an unattributed approval.',
            },
            {
              term: 'The gate cannot be routed around',
              text: '`specd spec pull` is refused server-side for anything unapproved, and CLI tokens are audience-scoped and rejected on every route that authors or approves.',
            },
            {
              term: 'Approval is append-only',
              text: '`approved → draft` is refused. v2 supersedes v1 while v1 keeps its stamp exactly as recorded.',
            },
            {
              term: 'A citation means someone can check it',
              text: 'Citations are validated against what was actually retrieved; invented paths are demoted to `UNVERIFIED`, because a citation that cannot be followed is worse than none.',
            },
            {
              term: 'The loop closes',
              text: 'The last task of every spec files the as-built copy. If the model omits it, specd appends it.',
            },
            {
              term: 'Spend cannot run away',
              text: 'Caps are checked **before** a run starts. Money is integer EUR cents — floats never touch it.',
            },
            {
              term: 'Agents never push',
              text: 'Editing tools only, the spec\'s own branch only, never a default branch. The build agent has no shell.',
            },
            {
              term: 'Webhooks cannot be impersonated',
              text: 'GitHub: HMAC over raw bytes, constant time, **before parsing**. GitLab: token echo, constant time. Both fail **closed** on an unset secret, dedupe by delivery id, and act only for a registered repository.',
            },
            {
              term: 'Leaving is free',
              text: 'Git holds the knowledge; the platform holds a derived index. Delete a project and nothing you would miss is gone.',
            },
          ],
        },
        { k: 'h2', text: 'Credentials' },
        {
          k: 'ul',
          items: [
            'Every connection secret is held with **envelope encryption** under a project-bound key (`VAULT_MASTER_KEY`), and never logged.',
            'Credentials are **verified against the provider before being stored**, so a bad one fails in front of you rather than inside an agent run.',
            'A **subscription credential is never seen, stored or proxied** — specd shells out to a CLI that is already signed in. That is also why a hosted specd could not offer that mode.',
            'A **runner token** lives in a separate keychain slot from a person\'s own CLI token, so pairing cannot clobber a session. Revoking a runner takes effect on its very next request, with no grace period.',
          ],
        },
        { k: 'h2', text: 'Tokens are audience-scoped' },
        {
          k: 'p',
          text: 'A CLI token, a runner token and a web session are different audiences, and the API checks which one is presenting before it checks what is being asked. This is what makes "the MCP server is read-only" a structural statement rather than a promise about the MCP server\'s code.',
        },
        { k: 'h2', text: 'The audit trail' },
        {
          k: 'p',
          text: 'Every webhook delivery is recorded with what specd decided **and why — including the ones it ignored**. "The webhook arrived and specd chose not to act" and "the webhook never arrived" are different problems, and the delivery log is what tells you which one you have. Rows are retained for 30 days by default.',
        },
        {
          k: 'note',
          tone: 'info',
          title: 'Reporting a vulnerability',
          text: 'See `SECURITY.md` in the repository. specd is pre-1.0 and local-first: there is no hosted service to disclose against yet, and `knowledge/runbooks/deploy.md` is an honest inventory of what a first deployment would need rather than a description of one that exists.',
        },
      ],
    },

    {
      slug: 'evals',
      title: 'Evals',
      summary:
        'Quality is graded against independent oracles rather than asserted — what is measured, on what corpus, and what the numbers do not prove.',
      audience: 'engineering',
      minutes: 5,
      blocks: [
        {
          k: 'lead',
          text: '`pnpm eval`, with results committed under `evals/results/`. Extraction is scored against oracles that share no assumptions with the code they grade.',
        },
        { k: 'h2', text: 'The scores' },
        {
          k: 'table',
          head: ['What', 'Oracle', 'Corpus', 'Score'],
          rows: [
            [
              'Symbol extraction (TypeScript)',
              'The TypeScript compiler',
              'this repo · 1,102 declarations',
              '98.7% precision · 100% recall',
            ],
            [
              'Symbol extraction (Go)',
              '`go/parser`',
              '**Go stdlib** · 7,654 files / 316k declarations',
              '**99.5% F1**',
            ],
            [
              'Symbol extraction (Python)',
              'The `ast` module',
              '**Python stdlib** · 3,830 files / 94k declarations',
              '**99.4% F1**',
            ],
            [
              'Retrieval',
              '15 labelled questions',
              'this repo\'s knowledge base',
              '100% recall · 0.861 MRR',
            ],
          ],
        },
        {
          k: 'p',
          text: 'The stdlib numbers are the ones worth quoting: large corpora nobody tuned against, graded by the language\'s own parser.',
        },
        { k: 'h2', text: 'What the harness refuses to fake' },
        {
          k: 'ul',
          items: [
            'A missing toolchain is reported as **skipped, naming which** — not as a pass.',
            'A zero-file corpus reports **"none here"** rather than a meaningless 100%.',
            'The retrieval number is called what it is: fifteen labelled questions is a **regression guard, not a benchmark**, and `evals/README.md` says so in those words.',
          ],
        },
        {
          k: 'note',
          tone: 'rule',
          title: 'Grades, not gates',
          text: 'The eval job runs in CI and posts its scores to the run summary, and is deliberately absent from the required checks. A quality score that blocks merges is a suite people learn to game rather than read.',
        },
      ],
    },
  ],
};
