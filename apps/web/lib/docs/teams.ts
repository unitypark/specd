import type { DocCategory } from './types';

/*
 * For teams — the pages a reader who is deciding whether to adopt specd needs,
 * plus the two support pages (FAQ, troubleshooting) that a search engine sends
 * people straight to.
 */
export const TEAMS: DocCategory = {
  title: 'For teams',
  blurb: 'Adoption, cost, and the answers to the questions people actually ask.',
  pages: [
    {
      slug: 'for-engineering-leaders',
      title: 'For engineering leaders',
      summary:
        'What changes for a team that adopts specd, who owns what, how to roll it out, and what to measure.',
      audience: 'leadership',
      minutes: 9,
      blocks: [
        {
          k: 'lead',
          text: 'specd is a process change with a tool attached, not the other way around. The tool is a weekend; the process change is the thing to plan.',
        },
        { k: 'h2', text: 'What actually changes' },
        {
          k: 'table',
          head: ['Before', 'After'],
          rows: [
            [
              'A ticket goes to an engineer, who assembles context by hand.',
              'A ticket becomes a drafted spec grounded in the team\'s own documentation.',
            ],
            [
              'Review happens on a diff, after the work is done.',
              'Review happens on a page, before the work starts. The diff review still happens, and is shorter.',
            ],
            [
              'Context lives in people\'s heads and in Slack.',
              'Context lives in `knowledge/`, in the repository, updated in the same pull request as the code.',
            ],
            [
              '"The AI wrote it" is the answer to who decided this.',
              'A named person approved a specific version, with a timestamp.',
            ],
          ],
        },
        { k: 'h2', text: 'Roles worth naming explicitly' },
        {
          k: 'dl',
          items: [
            {
              term: 'Spec approver',
              text: 'The person who reads and stamps. Usually a tech lead or a senior engineer on the area. **Name one per project.** An unowned approval queue is a stalled queue, and a stalled queue is how a team learns to route around the gate.',
            },
            {
              term: 'Knowledge owner',
              text: 'The person who cares whether `knowledge/` is true. Not a full-time job — mostly it is answering `UNVERIFIED` markers and keeping `README.md` a real map. But it is somebody\'s job or it is nobody\'s.',
            },
            {
              term: 'Everyone else',
              text: 'Reads the spec if it touches their area, reviews the pull request as normal, and updates the docs in the same change. That last habit is the one that makes the whole thing compound.',
            },
          ],
        },
        { k: 'h2', text: 'A rollout that tends to work' },
        {
          k: 'steps',
          items: [
            {
              title: 'Week 0 — one repository, one approver',
              text: 'Pick a repository somebody actively owns, not the scariest one and not a toy. Ground it, and spend real time reviewing the setup pull request: everything downstream cites it.',
            },
            {
              title: 'Week 1 — five specs, no build station',
              text: 'Draft and approve specs for work you were going to do anyway, and implement by hand. You are testing whether the specs are worth reading, without also testing the agent.',
            },
            {
              title: 'Week 2 — turn on the build station for the easy half',
              text: 'Well-bounded tasks first. Watch the first-pass acceptance rate and the size of the review comments.',
            },
            {
              title: 'Week 3 — decide what specd is a lane for',
              text: 'Write down which changes go through it and which do not. A typo fix does not need a spec, and pretending otherwise is how a good process gets a bad reputation.',
            },
            {
              title: 'Ongoing — watch the `UNVERIFIED` count',
              text: 'It should fall as the knowledge base fills in. If it is flat, the markers are being ignored rather than answered, and the docs are drifting.',
            },
          ],
        },
        { k: 'h2', text: 'What to measure' },
        {
          k: 'table',
          head: ['Signal', 'Healthy', 'Telling you something is wrong'],
          rows: [
            ['Ticket → approved spec, median', 'Days, trending down', 'Weeks — your docs cannot answer the questions yet'],
            ['First-pass PR acceptance', 'Rising', 'Flat — specs are being stamped, not read'],
            ['Citations per spec', 'Rising with coverage', 'Near zero — retrieval is not finding your documentation'],
            ['`UNVERIFIED` per spec', 'Falling', 'Rising — the knowledge base is drifting from the code'],
            ['Time from approval to merged PR', 'Stable', 'Growing — tasks are sized larger than one pull request'],
          ],
        },
        {
          k: 'note',
          tone: 'warn',
          title: 'Do not target the `UNVERIFIED` count to zero',
          text: 'It is the agent telling the truth about a gap. A team that optimises it away by loosening what counts as grounded has converted its most honest signal into a decorative one.',
        },
        { k: 'h2', text: 'The questions procurement and security will ask' },
        {
          k: 'dl',
          items: [
            {
              term: 'Where does our code go?',
              text: 'Nowhere specd holds. It records which repository, reads it when it needs to, and keeps a derived index. In local mode nothing leaves the machine at all.',
            },
            {
              term: 'What can the agent do to our repository?',
              text: 'Push a branch and open a pull request. It never pushes to a default branch, never merges, and has no shell. The GitHub App asks for three permissions and its tokens expire within the hour.',
            },
            {
              term: 'Who approved this change?',
              text: 'A named human, against a specific spec version, with a timestamp — enforced by a database constraint, append-only, and unavailable to any agent or API token.',
            },
            {
              term: 'What happens if we stop using it?',
              text: 'The knowledge base is markdown in your repository and stays there. You lose an index, and an index rebuilds.',
            },
            {
              term: 'Whose model is it?',
              text: 'Yours. An API key you supply, or the Claude subscription already signed in on your own hardware — specd never holds a subscription credential.',
            },
          ],
        },
        {
          k: 'p',
          text: 'The enforcement details behind each of these are in [Security and invariants](/docs/security).',
        },
        { k: 'h2', text: 'Be honest about the current stage' },
        {
          k: 'note',
          tone: 'warn',
          title: 'Pre-1.0, local-first',
          text: 'The full loop runs end to end on a developer machine, gated by CI against a real Postgres. There is no deployment story yet, Jira sync is one-way, billing is metered but not charged, and one runner executes one job at a time. Adopt it as a serious tool for a team that can run it themselves — not as a hosted service with an SLA.',
        },
      ],
    },

    {
      slug: 'costs-and-metering',
      title: 'Costs and metering',
      summary:
        'What a run costs, how spend is capped, and why money is stored as integer cents.',
      audience: 'leadership',
      minutes: 5,
      blocks: [
        {
          k: 'lead',
          text: 'specd does not resell inference — you bring the credential and pay your provider. What specd does is meter every run against a rate card and refuse to start one that would exceed a cap.',
        },
        { k: 'h2', text: 'The rate card' },
        {
          k: 'p',
          text: 'Anthropic first-party USD per million tokens, converted with `SPECD_USD_TO_EUR`. Cached input is billed at its own multiplier so the meter matches the invoice rather than approximating it.',
        },
        {
          k: 'table',
          head: ['Model', 'Input / MTok', 'Output / MTok', 'Context', 'Where it fits'],
          rows: [
            ['**Claude Opus 5** _(default)_', '$5.00', '$25.00', '1M', 'Deepest specs.'],
            ['**Claude Sonnet 5**', '$3.00', '$15.00', '1M', 'Balanced speed and cost.'],
            ['**Claude Haiku 4.5**', '$1.00', '$5.00', '200K', 'Drafts and indexing.'],
          ],
        },
        {
          k: 'p',
          text: 'The allowlist is exactly these three, set per project or via `SPECD_DEFAULT_MODEL`.',
        },
        { k: 'h2', text: 'Caps are checked before a run starts' },
        {
          k: 'note',
          tone: 'rule',
          title: 'Spend cannot run away',
          text: 'The per-project cap is enforced against total spend **before** every run — not reconciled afterwards, when the money is already gone. A run that would exceed the cap does not start, and says so.',
        },
        { k: 'h2', text: 'Money is integer EUR cents' },
        {
          k: 'p',
          text: 'Floats never touch money anywhere in specd. Accumulating thousands of small model calls in a float is how a meter drifts away from an invoice, and a meter that disagrees with the invoice is a meter nobody uses.',
        },
        { k: 'h2', text: 'Subscription runs are counted, not priced' },
        {
          k: 'p',
          text: 'In `subscription_runner` mode the run consumes your Claude subscription quota. specd records the tokens — so you can see what a spec cost in effort — but does not meter it in euros, because it did not cost euros.',
        },
        { k: 'h2', text: 'What is not built' },
        {
          k: 'ul',
          items: [
            '**Stripe billing.** Spend is metered and capped; nothing is charged.',
            '**Per-seat pricing or plans.** specd is pre-1.0 and self-run.',
          ],
        },
        {
          k: 'p',
          text: 'The keeping-it-cheap levers that actually matter: use Haiku for indexing-adjacent work, keep tasks sized to one pull request so a failed build is a small failed build, and let the knowledge base fill in — a well-grounded spec needs fewer retries than a cold-start one.',
        },
      ],
    },

    {
      slug: 'faq',
      title: 'FAQ',
      summary: 'The questions people ask in the first hour, answered without hedging.',
      audience: 'everyone',
      minutes: 7,
      blocks: [
        { k: 'h2', text: 'About the product' },
        {
          k: 'dl',
          items: [
            {
              term: 'Is specd a coding agent?',
              text: 'No. It is the process around one. It grounds a knowledge base, drafts specs, holds the gate, and dispatches an agent to build what was approved. You can also skip its build station entirely and hand the approved spec to whatever agent you already use.',
            },
            {
              term: 'Do I have to use Claude?',
              text: 'Today, yes — the model allowlist is Claude Opus 5, Sonnet 5 and Haiku 4.5, and the subscription mode drives the Claude Code CLI. The embedding side is provider-agnostic: any OpenAI-compatible `/v1/embeddings` endpoint works, including a local one.',
            },
            {
              term: 'Does my code leave my machine?',
              text: 'In local mode, no. Otherwise specd reads your repository through the provider\'s API with short-lived, repository-scoped credentials, and sends the retrieved passages to the model you configured. It never stores a copy of your repository.',
            },
            {
              term: 'Can the agent merge?',
              text: 'No. It opens a pull request. Merging is yours, and merging is also the event that closes the loop.',
            },
            {
              term: 'Can I approve a spec from the CLI?',
              text: 'No, and that is deliberate. The CLI fetches, registers and reports; the server refuses authoring and approving for CLI tokens regardless of what the binary asks. Approval is a signed-in human in the app.',
            },
            {
              term: 'What if the knowledge base is wrong?',
              text: 'Then the specs cite something wrong, and you will see it — that is what following a citation is for. Fix the document; the next index run picks it up. This is why the setup pull request is worth a real review.',
            },
            {
              term: 'What if we do not have any documentation?',
              text: 'Grounding writes the first version by reading your repository, and marks what it could not establish. Your first specs will carry more `UNVERIFIED` claims than your twentieth. That is the system working, not failing.',
            },
          ],
        },
        { k: 'h2', text: 'About running it' },
        {
          k: 'dl',
          items: [
            {
              term: 'Is there a hosted version?',
              text: 'Not yet. specd is pre-1.0 and local-first: you run it on your own machine or your own infrastructure. `knowledge/runbooks/deploy.md` is an honest inventory of what a first deployment would need rather than a description of one that exists.',
            },
            {
              term: 'What do I actually have to run?',
              text: 'Postgres, and specd. Postgres is the only runtime dependency — index runs are queued rows woken by `LISTEN/NOTIFY`, so there is no broker to operate.',
            },
            {
              term: 'Does it work without an API key?',
              text: 'Yes, minus the drafting. Indexing, retrieval, the graph, health, the CLI, MCP and the gate all work. Spec generation fails with a clear error rather than inventing content.',
            },
            {
              term: 'Why is retrieval only okay out of the box?',
              text: 'The default embedder is a deterministic local hash — offline, no extra key, and lexical. The full-text arm carries relevance until you point the index at a real embedding model, which can be a local one.',
            },
            {
              term: 'Can two people use the same project?',
              text: 'Yes. Approval is per-person and recorded by name, which is the whole point of having more than one.',
            },
          ],
        },
        { k: 'h2', text: 'What is not built yet' },
        {
          k: 'p',
          text: 'Stated plainly, because the wizard must not lie and neither should the documentation:',
        },
        {
          k: 'ul',
          items: [
            '**A deployment story.** specd runs as a development platform on your machine. Nothing deploys it as a service.',
            '**Jira inbound sync.** specd writes to Jira but does not listen — moving an issue in Jira does not move the spec.',
            '**gitlab.com OAuth.** Token paste only.',
            '**Stripe billing.** Spend is metered and capped, not billed.',
            '**Runner concurrency.** One job at a time per runner.',
            '**The retrieval ceiling.** With the default embedder, both retrieval arms measure similar signals. Everything around it is tuned; the ceiling needs a key or a local model.',
          ],
        },
        { k: 'h2', text: 'About the project' },
        {
          k: 'dl',
          items: [
            {
              term: 'What licence?',
              text: 'MIT.',
            },
            {
              term: 'Does specd use specd?',
              text: 'Yes. This repository\'s own `knowledge/` is a live instance of the product\'s knowledge base — ADRs, runbooks, as-built specs, and the research that shaped the engine. Start at `knowledge/README.md`.',
            },
            {
              term: 'How do I contribute?',
              text: '`CONTRIBUTING.md` in the repository. The verify gate is `pnpm typecheck && pnpm test`, and CI runs exactly those two commands against a real pgvector service.',
            },
          ],
        },
      ],
    },

    {
      slug: 'troubleshooting',
      title: 'Troubleshooting',
      summary: 'Symptom, cause, fix — for the failures that actually happen.',
      audience: 'engineering',
      minutes: 5,
      blocks: [
        {
          k: 'lead',
          text: 'Start with `specd doctor`. It reports config, server, database, embeddings, credential, identity and default project in dependency order, and skips what an earlier failure makes unknowable — so one broken thing reads as one broken thing.',
        },
        { k: 'h2', text: 'Getting it running' },
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
              'Same error, `.env` exists',
              'Not at the repo root, or the value is empty',
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
              'The API died at startup, and `node --watch` keeps a crashed process alive — so `pnpm dev` still looks healthy',
              '`curl localhost:4000/api/health`; nothing answering confirms it. The reason is in the API\'s own output, scrolled past by the web server\'s. The next row is the usual cause.',
            ],
            [
              '`@specd/db does not provide an export named …`',
              '`packages/*/dist` is missing or older than its `src`',
              '`pnpm --filter "./packages/*" build`. `dist` is gitignored and no install hook builds it, so this is also needed after any pull that touched a package.',
            ],
            [
              'Web dev server 500s after `pnpm build`',
              '`next build` and `next dev` share `apps/web/.next` in incompatible shapes',
              'Stop the dev server, `rm -rf apps/web/.next`, start it again.',
            ],
          ],
        },
        { k: 'h2', text: 'Tests and CI' },
        {
          k: 'table',
          head: ['Symptom', 'Cause', 'Fix'],
          rows: [
            [
              'A whole test file reports _skipped_',
              'No database reachable — or the suite\'s own `beforeAll` threw',
              'Bring Postgres up. If it persists, suspect the suite\'s setup rather than the database.',
            ],
            [
              'CI fails complaining that tests skipped',
              'The Postgres-dependent suites self-skipped in CI',
              'That is the point — a broken CI database would otherwise look identical to a pass. Fix the service, not the check.',
            ],
            [
              '`pnpm typecheck` fails on a clean checkout',
              'The workspace packages have not been built',
              '`pnpm --filter "./packages/*" build` first; `pnpm typecheck` does this itself.',
            ],
          ],
        },
        { k: 'h2', text: 'Agents and integrations' },
        {
          k: 'table',
          head: ['Symptom', 'Cause', 'Fix'],
          rows: [
            [
              'Spec generation fails with an error about credentials',
              'No model credential for this project',
              'Set `ANTHROPIC_API_KEY`, or `SPECD_AI_MODE=subscription_runner` with Claude Code signed in. See [Bring your own model](/docs/bring-your-own-model).',
            ],
            [
              'Merges are not detected',
              'No webhook reaching the API',
              'Locally, forward deliveries (`gh webhook forward` or a tunnel) — or use the "I merged it" button. See [GitHub](/docs/github).',
            ],
            [
              'Every webhook delivery fails the signature check',
              '`GITHUB_WEBHOOK_SECRET` does not match the sender',
              '`gh webhook forward` re-signs with **its own** secret and prints it — use that value while forwarding.',
            ],
            [
              'The API refuses to start, naming an embedding dimension',
              'The configured embedding model does not produce 1024-dimension vectors',
              'Use one that does (`mxbai-embed-large` fits; `nomic-embed-text` is 768).',
            ],
            [
              'A dispatched job never starts',
              'No paired runner, or the daemon is not running',
              'Check Settings → runners for last-heard-from. `specd runner pair` reports connectivity at pairing time for exactly this reason.',
            ],
            [
              'A job keeps being reclaimed and finally fails',
              'The runner dies mid-job',
              'After three reclaims specd fails it as _repeatedly abandoned_ rather than bouncing forever. Look at the runner, not the queue.',
            ],
            [
              'A build reports **could not run** rather than failed',
              'The toolchain is missing on the machine that built it',
              'Nothing was proved either way. Fix the environment and re-run — this is deliberately not reported as a test failure.',
            ],
          ],
        },
        { k: 'h2', text: 'Resetting' },
        {
          k: 'p',
          text: '`pnpm infra:down` is a plain `docker compose down` — the data volume survives. For a true reset:',
        },
        {
          k: 'code',
          caption: 'terminal',
          code: `docker compose down -v
pnpm infra:up && pnpm db:migrate && pnpm db:seed`,
        },
      ],
    },
  ],
};
