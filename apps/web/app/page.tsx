import Link from 'next/link';
import { LandingNav } from '@/components/LandingNav';
import { Linework } from '@/components/Linework';
import { Logo } from '@/components/Logo';
import { CompoundingLoop } from '@/components/CompoundingLoop';
import { TicketToSpec } from '@/components/TicketToSpec';
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

      {/* 1 · HERO — unchanged, it already works. */}
      <section className={`${landing.heroband} ${styles.heroCharcoal}`}>
        <div className={landing.hero}>
          <div>
            <p className="tag">FAIR-CODE • SPEC-DRIVEN • ONE-STOP SETUP</p>
            <h1 className={landing.h1}>
              <span>Software,</span>
              <span>built</span>
              <span>
                <em>to spec.</em>
              </span>
            </h1>
            <p className={landing.sub}>
              One setup builds your knowledge base, briefs a custom agent with your full context,
              and gates every change behind a <b>human-approved spec</b>.
            </p>
            <div className={landing.ctas}>
              <Link href="/setup" className={landing.cta}>
                Start your setup
              </Link>
              <Link href="/login" className={landing.ghost}>
                Sign in
              </Link>
            </div>
            <p className={landing.trust}>
              one fixed pipeline · your git stays the source of truth · agents open PRs, never push
            </p>
          </div>
          <div>
            <CompoundingLoop />
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
            <div className={`${styles.card} ${styles.good}`}>
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
        <div className={styles.finmark}>
          <Logo variant="face" size={64} title="specd" />
        </div>
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
      </section>
    </main>
  );
}
