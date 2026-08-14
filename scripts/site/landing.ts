/*
 * The published site's front page.
 *
 * It carries the same argument as the app's landing page but is not a copy of
 * it: the app's version can send you into a wizard, and this one cannot —
 * there is no hosted specd. So every call to action here ends at either the
 * quickstart or the repository, which are the two things a visitor can
 * actually do.
 *
 * Every number on this page is reproducible from the repository. The invented
 * pilot metrics that appear on the in-app landing page are labelled as
 * invented there and are deliberately absent here, where a first-time visitor
 * has no context to read the label with.
 */

import { esc, shell, type Up } from './render';

const REPO = 'https://github.com/unitypark/specd';

const STATIONS: [string, string, boolean][] = [
  ['Connect', 'Point specd at your repositories, a model and a tracker.', false],
  ['Ground', 'It reads the repo and opens a PR carrying your knowledge base.', false],
  ['Spec', 'A ticket becomes requirements, a cited design, and tasks.', false],
  ['The gate', 'A named human approves that exact version. Nothing skips this.', true],
  ['Build', 'One commit per task, on the spec’s own branch, as a pull request.', false],
  ['Learn', 'You merge — the as-built spec files itself and the index refreshes.', false],
];

const STATS: [string, string, string][] = [
  ['99.5%', 'F1 · Go symbol extraction', 'graded by go/parser over the Go stdlib — 7,654 files, 316k declarations'],
  ['99.4%', 'F1 · Python symbol extraction', 'graded by the ast module over the Python stdlib — 94k declarations'],
  ['100%', 'retrieval recall', 'on the labelled question set · 0.861 MRR'],
  ['0', 'unapproved agent changes', 'enforced in the state machine and a database CHECK constraint'],
];

const PLUGS = ['GitHub', 'GitLab', 'Jira', 'Claude Code', 'Cursor', 'Windsurf', 'MCP', 'Postgres'];

const HOW: [string, string, string][] = [
  [
    '01',
    'Connect and ground',
    'specd reads your repositories — manifests, CI workflows, compose files, schemas, layout — and writes your team a knowledge base as a pull request you review. What it could not establish says <code>UNVERIFIED</code> rather than being guessed at.',
  ],
  [
    '02',
    'Draft and approve',
    'A ticket becomes a spec with testable criteria and a citation behind every design claim. You read it and stamp it. Nothing downstream moves without that stamp — not the agent, not the CLI, not a script that asks nicely.',
  ],
  [
    '03',
    'Build and merge',
    'The agent implements only what you approved, one commit per task, and opens a pull request. Merging files the as-built spec back into <code>knowledge/</code> — so the next spec starts better grounded than the last.',
  ],
];

const START_CARDS: [string, string, string][] = [
  ['What is specd?', 'The whole idea in six minutes, no commands required.', 'docs/what-is-specd/'],
  ['Quickstart', 'Clone, one command, running locally in about five minutes.', 'docs/quickstart/'],
  ['Your first spec', 'A guided walk through all six stations.', 'docs/your-first-spec/'],
  ['For engineering leaders', 'Rollout, ownership, and what to measure.', 'docs/for-engineering-leaders/'],
];

export function landing(origin: string): string {
  const up: Up = '';

  const body = `
<main id="main">

  <section class="hero">
    <div>
      <ul class="chips">
        <li>Spec-driven delivery</li>
        <li>Human-approved by design</li>
      </ul>
      <h1 class="h1">Software, built <em>to spec.</em></h1>
      <p class="sub">
        specd grounds a knowledge base in your own repositories, drafts every ticket into a spec
        with a <b>citation behind each claim</b>, and gates it behind a <b>named human</b> — so the
        agent builds what you approved, and nothing else.
      </p>
      <div class="ctas">
        <a class="btn primary" href="docs/quickstart/">Get started</a>
        <a class="btn ghost" href="docs/">Read the docs</a>
      </div>
      <p class="trustline">
        MIT licensed · Postgres is the only runtime dependency · agents open PRs, never push
      </p>

      <div class="terminal">
        <span class="cap">Try it locally</span>
        <pre><b>git clone</b> https://github.com/unitypark/specd.git
<b>pnpm install</b> &amp;&amp; <b>pnpm demo</b></pre>
        <span class="note">Postgres, the API and the web app — one command, on your machine.</span>
      </div>
    </div>

    <div class="stations">
      <h2>The line · fixed for every project</h2>
      <ol>
        ${STATIONS.map(
          ([name, text, gate]) =>
            `<li${gate ? ' class="gate"' : ''}><b>${esc(name)}</b><span>${esc(text)}</span></li>`,
        ).join('\n        ')}
      </ol>
    </div>
  </section>

  <section class="band">
    <div class="section">
      <dl class="stats">
        ${STATS.map(
          ([v, l, n]) =>
            `<div><dt>${esc(v)}</dt><dd><b>${esc(l)}</b><span>${esc(n)}</span></dd></div>`,
        ).join('\n        ')}
      </dl>
      <p class="trustline" style="margin-top:1.2rem">
        Extraction and retrieval scores come from <code>pnpm eval</code>, graded against independent
        oracles — the language’s own parser, not a rubric specd wrote for itself — and committed
        under <code>evals/results/</code>.
      </p>
      <div class="plugs">
        <span>Plugs into</span>
        <ul>${PLUGS.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
      </div>
    </div>
  </section>

  <section class="band">
    <div class="section">
      <span class="kicker">The one rule</span>
      <h2 class="h2">No agent writes code your team hasn’t approved</h2>
      <p class="lede">
        Not a setting. Not a best practice someone has to remember. A named human approves every
        spec before a line is written — and the approval is pinned to that exact version,
        permanently.
      </p>
      <div class="compare">
        <div>
          <h3>A generic coding agent</h3>
          <ul>
            <li>Rediscovers your architecture every session, from raw code</li>
            <li>Invents conventions, then drifts from the ones you have</li>
            <li>Ships assumptions silently — you find them in review</li>
            <li>Leaves nothing behind: session twenty is as uninformed as session one</li>
          </ul>
        </div>
        <div class="good">
          <h3>Your specd agent</h3>
          <ul>
            <li>Reads your knowledge base first — it is rule one of its brief</li>
            <li>Cites the document behind every design claim it makes</li>
            <li>Flags what it cannot ground instead of guessing quietly</li>
            <li>Files what it built back, so the next spec starts better grounded</li>
          </ul>
        </div>
      </div>
    </div>
  </section>

  <section class="band">
    <div class="section">
      <span class="kicker">How it works</span>
      <h2 class="h2">Three steps. The middle one is yours.</h2>
      <p class="lede">
        Everything mechanical is automated. You keep the two decisions that actually carry risk —
        what gets built, and what gets merged.
      </p>
      <div class="grid3">
        ${HOW.map(
          ([n, t, b]) => `<div class="tile"><code>${n}</code><h3>${esc(t)}</h3><p>${b}</p></div>`,
        ).join('\n        ')}
      </div>
    </div>
  </section>

  <section class="band">
    <div class="section">
      <span class="kicker">The spec</span>
      <h2 class="h2">Every change starts as something you can read</h2>
      <p class="lede">
        Testable acceptance criteria, a citation behind every design decision, and tasks sized to one
        pull request. If the agent could not ground a claim in your own docs, it says so instead of
        guessing.
      </p>
      <img src="shots/spec.png" width="1440" height="720" loading="lazy"
        style="border:1px solid var(--line);border-radius:12px;display:block"
        alt="A spec open for review in specd: EARS acceptance criteria, six citations, five claims flagged UNVERIFIED.">
    </div>
  </section>

  <section class="band">
    <div class="section">
      <span class="kicker">The knowledge engine</span>
      <h2 class="h2">A knowledge graph, not just a vector store</h2>
      <p class="lede">
        Five deterministic link kinds extracted with parser rules — no model ever runs at index
        time, because a hallucinated edge poisons retrieval invisibly. Retrieval is rank fusion over
        pgvector and Postgres full-text, then one hop across the graph, with every added passage
        carrying the edge that pulled it in.
      </p>
      <img src="shots/knowledge.png" width="1440" height="720" loading="lazy"
        style="border:1px solid var(--line);border-radius:12px;display:block;margin-bottom:2rem"
        alt="The knowledge view: indexed documents from the repository with a health score and staleness flags.">
      <div class="grid3">
        <a class="tile" href="docs/retrieval-engine/">
          <h3>Three bounded stages</h3>
          <p>Rank fusion, a graph hop, then the actual source of the symbols your docs reference.</p>
        </a>
        <a class="tile" href="docs/specs-and-citations/">
          <h3>Four citation verdicts</h3>
          <p><code>supported</code>, <code>unsupported</code>, <code>unknown</code>, <code>stale</code> — because “I found no evidence” and “no evidence exists” are different answers.</p>
        </a>
        <a class="tile" href="docs/knowledge-base/">
          <h3>Drift measured against code</h3>
          <p>Coupling mined from git history names the code to go read. A 90-day timer only measures time passing.</p>
        </a>
      </div>
    </div>
  </section>

  <section class="band">
    <div class="section">
      <span class="kicker">Start here</span>
      <h2 class="h2">Pick a door</h2>
      <div class="grid3">
        ${START_CARDS.map(
          ([t, d, h]) => `<a class="tile" href="${h}"><h3>${esc(t)}</h3><p>${esc(d)}</p></a>`,
        ).join('\n        ')}
      </div>
    </div>
  </section>

  <section class="band">
    <div class="section closing">
      <span class="kicker">Pre-1.0 · local-first</span>
      <h2 class="h2">Run it on your own machine.</h2>
      <p class="lede">
        specd runs the whole loop end to end against a real Postgres, gated by CI. There is no
        hosted service yet, and the docs say exactly what a first deployment would still need.
      </p>
      <div class="ctas" style="justify-content:center">
        <a class="btn primary" href="docs/quickstart/">Read the quickstart</a>
        <a class="btn ghost" href="${REPO}" target="_blank" rel="noreferrer noopener">View on GitHub</a>
      </div>
    </div>
  </section>

</main>`;

  return shell({
    title: 'specd — software, built to spec',
    description:
      'specd grounds a knowledge base in your repositories, drafts every ticket into a cited spec, and gates it behind a named human — so the agent builds what you approved, and nothing else.',
    up,
    active: 'home',
    path: '',
    origin,
    body,
  });
}
