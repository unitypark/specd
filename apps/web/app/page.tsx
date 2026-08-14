import Link from 'next/link';
import { AuthLink } from '@/components/AuthLink';
import { LandingNav } from '@/components/LandingNav';
import { Linework } from '@/components/Linework';
import { CompoundingLoop } from '@/components/CompoundingLoop';
import { TicketToSpec } from '@/components/TicketToSpec';
import { FinaleReveal } from '@/components/FinaleReveal';
import landing from './landing.module.css';
import styles from './landing-page.module.css';



const STEPS = [
  {
    n: '01',
    title: 'Connect',
    body: 'Point specd at your repos. It reads them and writes your team a knowledge base — architecture, conventions, decisions — as a pull request you review.',
  },
  {
    n: '02',
    title: 'Approve',
    body: 'A ticket becomes a spec with testable criteria and a citation behind every design claim. You read it and stamp it. Nothing moves without that.',
  },
  {
    n: '03',
    title: 'Ship',
    body: 'The agent builds only what you approved, one commit per task, and opens a PR. Merging files the as-built spec back — so the next spec starts smarter.',
  },
];

/*
 * The hero's numbers. Unlike METRICS below — which are openly labelled as a
 * fictional pilot — every one of these is reproducible from this repository:
 * the first three are `pnpm eval` output, the fourth is an invariant with a
 * test and a database CHECK constraint behind it.
 */
const HERO_STATS: [string, string, string][] = [
  ['99.5%', 'F1 · Go symbol extraction', 'graded by go/parser over the Go stdlib — 316k declarations'],
  ['100%', 'retrieval recall', 'on the labelled question set · 0.861 MRR'],
  ['4', 'citation verdicts', 'supported · unsupported · unknown · stale'],
  ['0', 'unapproved agent changes', 'enforced in the state machine and a database constraint'],
];

/** What specd sits between, named plainly. */
const PLUGS = ['GitHub', 'GitLab', 'Jira', 'Claude Code', 'Cursor', 'MCP', 'Postgres'];

const METRICS = [
  ['2.1', ' days', 'TICKET → APPROVED SPEC', 'median cycle: draft plus one review round'],
  ['84', '%', 'FIRST-PASS PR ACCEPTANCE', 'merged without rework — the spec caught it earlier'],
  ['9.2', '', 'CITATIONS PER SPEC', 'every design claim grounded in your own docs'],
  ['100', '%', 'HUMAN-APPROVED CHANGES', 'no agent code without a named approval'],
];

const TRUST = [
  {
    title: 'Your git is the source of truth',
    body: 'Knowledge lives in your repositories as plain markdown. specd keeps a derived index — delete the account and you lose nothing you would miss.',
  },
  {
    title: 'Your keys, or your machine',
    body: 'Bring your own API key, or run the agent on your own hardware where your credentials already live. We never hold your subscription.',
  },
  {
    title: 'Agents never push',
    body: 'Every change arrives as a branch and a pull request, scoped to the repos you granted, with tokens that expire in an hour.',
  },
];

/**
 * The landing page: outcome first, mechanism one click deeper.
 *
 * The hero is carried over verbatim, since that part already works. Everything
 * below it is rebuilt: one idea per screen, roughly double the whitespace, and
 * the six-station schematic, the ticket→spec walkthrough and the eight-row
 * automation table moved off the page entirely.
 */
export default function Preview() {
  return (
    <main className={styles.page}>
      <LandingNav />

      {/*
        1 · HERO.
        Restructured on the anatomy the reference page (graphify.com) uses, in
        this order: capability chips, the claim, how it works in one sentence,
        two actions plus a quiet third, the one command, then numbers and the
        things it plugs into. The point of the shape is that a visitor who
        reads only the top 700px still learns what specd is, what it costs to
        try, and what backs the claim.

        Every number in the strip is one this repository can produce on
        demand — `pnpm eval` writes them to evals/results/. The invented pilot
        metrics further down the page are labelled as invented; the hero is
        not the place for those.
      */}
      <section className={`${landing.heroband} ${styles.heroCharcoal}`}>
        <div className={landing.hero}>
          <div>
            {/* Two chips rather than one line with a separator: a mid-string
                dot strands itself at the end of a line when the pair wraps,
                which is every phone. */}
            <p className={styles.eyebrow}>
              <span>Spec-driven delivery</span>
              <span>Human-approved by design</span>
            </p>
            <h1 className={landing.h1}>
              <span>Software,</span>
              <span>built</span>
              <span>
                <em>to spec.</em>
              </span>
            </h1>
            <p className={landing.sub}>
              specd grounds a knowledge base in your own repositories, drafts every ticket into a
              spec with a <b>citation behind each claim</b>, and gates it behind a{' '}
              <b>named human</b> — so the agent builds what you approved, and nothing else.
            </p>
            <div className={landing.ctas}>
              <Link href="/setup" className={landing.cta}>
                Start your setup
              </Link>
              <Link href="/docs" className={styles.heroSecondary}>
                Read the docs
              </Link>
              <AuthLink
                className={landing.ghost}
                signInLabel="Sign in"
                dashboardLabel="Go to your projects"
              />
            </div>
            <p className={landing.trust}>
              MIT licensed · Postgres is the only runtime dependency · agents open PRs, never push
            </p>

            {/* The one command, shown rather than described. A visitor
                evaluating a developer tool wants to know what trying it costs
                before they want to know what it does. */}
            <div className={styles.install}>
              <span className={styles.installcap}>TRY IT LOCALLY</span>
              <code>
                <b>git clone</b> https://github.com/unitypark/specd.git
                {'\n'}
                <b>pnpm install</b> && <b>pnpm demo</b>
              </code>
              <span className={styles.installnote}>
                Postgres, the API and the web app — one command, on your machine.
              </span>
            </div>
          </div>
          <div>
            <CompoundingLoop />
          </div>
        </div>

        <div className={styles.proof}>
          <div className={styles.proofin}>
            <dl className={styles.stats}>
              {HERO_STATS.map(([value, label, note]) => (
                <div key={label}>
                  <dt>{value}</dt>
                  <dd>
                    <b>{label}</b>
                    <span>{note}</span>
                  </dd>
                </div>
              ))}
            </dl>
            <p className={styles.proofnote}>
              Extraction and retrieval scores come from <code>pnpm eval</code>, graded against
              independent oracles and committed under <code>evals/results/</code>.
            </p>
            <div className={styles.plugs}>
              <span>Plugs into</span>
              <ul>
                {PLUGS.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/*
        The centrepiece, and the only full-width row on the page. A screenshot
        of a board is a static artifact; watching a ticket become a spec is the
        automation itself, which is the thing people actually react to. It also
        needs the width — its internal three-column layout collapses below
        880px, and a side-by-side column is only ~805px.
      */}
      {/* The conversion demo, on its own again — it is a different kind of
          thing from the three arguments below it, and grouping them made the
          card too tall to read as one object. */}
      <section className={`${styles.sec} ${styles.secrel}`}>
        <div className={styles.in}>
          <div className={styles.showcase}>
                      <span className={styles.kicker}>JIRA → SPEC</span>
                      <h2 className={styles.showh}>
                        Two sentences in a ticket become an engineering spec —{' '}
                        <em className={styles.underlined}>
                          watch
                          <Linework variant="underline" className={styles.lnUnderline} />
                        </em>
                      </h2>
                      <p className={styles.showp}>
                        No one rewrites the ticket. Every requirement traces back to a phrase someone
                        actually wrote, the gaps get filled from your knowledge base, and what the agent
                        cannot ground is flagged for a human instead of guessed at.
                      </p>
                    </div>
          <div className={`${styles.viz} ${styles.wide}`}>
                      <TicketToSpec />
                    </div>
          <p className={styles.showfoot}>
                      the ticket stays in Jira · status syncs both ways · a human stamps it before any code
                    </p>
        </div>
      </section>

      {/*
        The three arguments, grouped into one card. They were three separate
        sections alternating sides, which read as three unrelated claims. One
        card with a consistent copy-left / visual-right rhythm reads as one
        argument in three parts.
      */}
      <section className={`${styles.sec} ${styles.secrel}`}>
        <Linework variant="arc" className={styles.lnArc} />
        <div className={styles.in}>
          <div className={styles.group}>
            <div className={styles.feature}>
                        <div className={`${styles.copy} ${styles.copyLoud}`}>
                          <span className={styles.kicker}>THE ONE RULE</span>
                          <h2>
                            No agent writes <span className={styles.outline}>code</span> your team{' '}
                            <em>hasn’t approved</em>
                          </h2>
                          <p>
                            Not a setting. Not a best practice someone has to remember. A named human approves
                            every spec before a line is written — and the approval is pinned to that exact
                            version, permanently.
                          </p>
                          <span className={styles.enforced}>
                            enforced in the state machine, at the API boundary, and by a database constraint
                          </span>
                        </div>

                        <div className={`${styles.viz} ${styles.ruleviz}`}>
                          <div className={styles.stamp}>
                            APPROVED
                            <small>DANA K. · 2026-08-05</small>
                          </div>
                          <dl className={styles.record}>
                            <div>
                              <dt>spec</dt>
                              <dd>S-103 · v1</dd>
                            </div>
                            <div>
                              <dt>approved by</dt>
                              <dd>Dana Kowalski</dd>
                            </div>
                            <div>
                              <dt>at</dt>
                              <dd>2026-08-05 14:22 UTC</dd>
                            </div>
                            <div>
                              <dt>pinned to</dt>
                              <dd>v1 — a revision starts a new version, never edits this one</dd>
                            </div>
                          </dl>
                        </div>
                      </div>

            <div className={`${styles.feature}`}>
                        <div className={styles.copy}>
                          <span className={styles.kicker}>THE SPEC</span>
                          <h2>
                            Every change starts as something <em>you can read</em>
                          </h2>
                          <p>
                            Testable acceptance criteria, a citation behind every design decision, and tasks
                            sized to one pull request. If the agent could not ground a claim in your own docs,
                            it says so instead of guessing.
                          </p>
                          <Link href="/docs" className={styles.inlinelink}>
                            HOW SPECS ARE WRITTEN →
                          </Link>
                        </div>
                        <div className={`${styles.viz} ${styles.shot}`}>
                          <div className={styles.inner}>
                            <img
                              src="/shots/spec.png"
                              alt="A spec open for review in specd: EARS acceptance criteria, six citations, five claims flagged UNVERIFIED."
                              width={1440}
                              height={720}
                            />
                          </div>
                        </div>
                      </div>

            <div className={styles.feature}>
                        <div className={styles.copy}>
                          <span className={styles.kicker}>THE LINE</span>
                          <h2>
                            One pipeline. <em>Nothing to assemble.</em>
                          </h2>
                          <p>
                            Not a workflow builder — the pipeline <b>is</b> the product. Every project gets the
                            same six stations; setup only asks what plugs into each one. Nothing can be
                            mis-wired, and the human gate cannot be optimised away.
                          </p>
                        </div>
                        <div className={`${styles.viz} ${styles.shot}`}>
                          <img
                            src="/shots/knowledge.png"
                            alt="The knowledge view: indexed documents from the repository with a health score and staleness flags."
                            width={1440}
                            height={720}
                          />
                        </div>
                      </div>
          </div>
        </div>
      </section>

      <section className={styles.sec}>
        <div className={styles.in}>
          <span className={styles.kicker}>HOW IT WORKS</span>
          <h2 className={styles.h2}>Three steps. The middle one is yours.</h2>
          <p className={styles.lede}>
            Everything mechanical is automated. You keep the two decisions that actually carry
            risk — what gets built, and what gets merged.
          </p>
          <div className={styles.steps}>
            {STEPS.map((s) => (
              <div key={s.n} className={styles.step}>
                <span className={styles.stepno}>{s.n}</span>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 4 · VS */}
      <section className={styles.sec}>
        <div className={styles.in}>
          <span className={styles.kicker}>THE DIFFERENCE</span>
          <h2 className={styles.h2}>An agent that has read your codebase</h2>
          <p className={styles.lede}>
            Most coding agents start every session as a stranger. Yours starts having read the
            architecture, the conventions and every spec you ever shipped.
          </p>
          <div className={styles.vs}>
            <div className={styles.card}>
              <h4>A generic coding agent</h4>
              <ul>
                <li>Rediscovers your architecture every session, from raw code</li>
                <li>Invents conventions, then drifts from the ones you have</li>
                <li>Ships assumptions silently — you find them in review</li>
              </ul>
            </div>
            <div className={`${styles.card} ${styles.good} glass`}>
              <h4>Your specd agent</h4>
              <ul>
                <li>Reads your knowledge base first — it is rule one of its brief</li>
                <li>Cites the document behind every design claim it makes</li>
                <li>Flags what it cannot ground instead of guessing quietly</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* 5 · PROOF */}
      <section className={`${styles.sec} ${styles.secrel}`}>
        <Linework variant="corner" className={styles.lnCorner} />
        <div className={styles.in}>
          <span className={styles.kicker}>PROOF</span>
          <h2 className={styles.h2}>“The AI helps” should be a number</h2>
          <p className={styles.lede}>
            specd instruments the pipeline it installs, so the effect on your delivery is something
            you can check rather than something you have to feel.
          </p>
          <div className={styles.metrics}>
            {METRICS.map(([value, unit, label, note]) => (
              <div key={label} className={styles.metric}>
                <div className={styles.mval}>
                  {value}
                  {unit && <small>{unit}</small>}
                </div>
                <div className={styles.mlab}>{label}</div>
                <p className={styles.mnote}>{note}</p>
              </div>
            ))}
          </div>
          <p className={styles.caveat}>
            sample values from a fictional pilot — your dashboard computes these from your own
            pipeline.
          </p>
        </div>
      </section>

      {/* 6 · TRUST */}
      <section className={styles.sec}>
        <div className={styles.in}>
          <span className={styles.kicker}>CONTROL</span>
          <h2 className={styles.h2}>Nothing here locks you in</h2>
          <div className={styles.trust}>
            {TRUST.map((t) => (
              <div key={t.title} className={styles.tcard}>
                <h4>{t.title}</h4>
                <p>{t.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 8 · CLOSE */}
      <section className={styles.close}>
        <FinaleReveal>
          <h2 className={styles.closeh}>
            Ship faster. <em>Approve everything.</em>
          </h2>
          <p className={styles.closesub}>
            Connect a repository and specd writes your knowledge base, drafts your first spec, and
            waits for your stamp.
          </p>
          <Link href="/setup" className={styles.big}>
            Start your setup
          </Link>
          <p className={styles.deeper}>
            WANT THE MECHANICS? <Link href="/docs">READ THE DOCS</Link>
          </p>
        </FinaleReveal>
      </section>
    </main>
  );
}
