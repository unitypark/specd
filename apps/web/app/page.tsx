import Link from 'next/link';
import { Pipeline } from '@/components/Pipeline';
import { SpecSheet } from '@/components/SpecSheet';
import styles from './landing.module.css';

/**
 * The landing page. Its job is not to describe the product but to show it
 * working: the hero drafts a real spec and stamps it, and the schematic is
 * the same fixed line the app runs.
 */
export default function Landing() {
  return (
    <main className={styles.page}>
      <nav className={styles.nav}>
        <span className={styles.logo}>
          spec<i>d</i>
        </span>
        <span className={styles.flex} />
        <span className={styles.rev}>V0.1</span>
        <Link href="/login" className={styles.navlink}>
          SIGN IN
        </Link>
        <Link href="/setup" className={styles.cta}>
          Start your setup
        </Link>
      </nav>

      <section className={styles.hero}>
        <div>
          <p className="tag">FAIR-CODE • SPEC-DRIVEN • ONE-STOP SETUP</p>
          <h1 className={styles.h1}>
            <span>Software,</span>
            <span>built</span>
            <span>
              <em>to spec.</em>
            </span>
          </h1>
          <p className={styles.sub}>
            One setup builds your knowledge base, briefs a custom agent with your full context,
            and gates every change behind a <b>human-approved spec</b>.
          </p>
          <div className={styles.ctas}>
            <Link href="/setup" className={styles.cta}>
              Start your setup
            </Link>
            <Link href="/login" className={styles.ghost}>
              Sign in
            </Link>
          </div>
          <p className={styles.trust}>
            one fixed pipeline · your git stays the source of truth · agents open PRs, never push
          </p>
        </div>
        <div>
          <SpecSheet />
        </div>
      </section>

      <section className={styles.sec}>
        <div className={styles.in}>
          <span className="tag">01 · THE SYSTEM</span>
          <h2 className={styles.h2}>One pipeline. Six fixed stations. Zero assembly.</h2>
          <p className={styles.lede}>
            This is deliberately <b>not</b> a workflow builder — the pipeline <em>is</em> the
            product. Every project gets the same proven line; the setup only asks what plugs into
            each station. Nothing can be skipped, nothing can be mis-wired, and the human gate can
            never be optimized away.
          </p>
          <Pipeline />
        </div>
      </section>

      <section className={styles.sec}>
        <div className={styles.in}>
          <span className="tag">02 · THE AGENT</span>
          <h2 className={styles.h2}>
            An agent briefed like a senior hire — not a stranger with autocomplete
          </h2>
          <p className={styles.lede}>
            Every project gets an agent whose first duty is reading. The setup builds it a curated,
            versioned knowledge base — architecture, conventions, glossary, decisions, and every
            spec ever delivered — and installs working agreements that make reading, citing and
            maintaining that knowledge non-negotiable.
          </p>

          <div className={styles.cmp}>
            <div className={`${styles.cmpcard} ${styles.them}`}>
              <h4>A generic coding agent</h4>
              <ul>
                <li>Rediscovers your architecture every session — expensively, from raw code</li>
                <li>Invents conventions with confidence; drifts from the ones you have</li>
                <li>Ships assumptions silently — you find them in review, or in production</li>
                <li>Its context evaporates when the session ends</li>
              </ul>
            </div>
            <div className={`${styles.cmpcard} ${styles.us}`}>
              <h4>Your specd agent</h4>
              <ul>
                <li>
                  Reads <code>knowledge/</code> first — architecture, conventions, glossary, ADRs,
                  past as-built specs. Rule 1 of its <code>AGENTS.md</code>
                </li>
                <li>
                  Works only from a <b>human-approved spec</b> with testable EARS criteria
                </li>
                <li>
                  Cites the doc behind every design claim; what it can’t ground is flagged{' '}
                  <b>UNVERIFIED</b>, never hidden
                </li>
                <li>
                  Files what it built back to <code>knowledge/specs/</code> — context{' '}
                  <b>compounds</b> instead of evaporating
                </li>
              </ul>
            </div>
          </div>

          <div className={styles.note}>
            <b>Full context is not a longer prompt.</b> It’s a curated knowledge base the agent
            must read, cite and maintain — versioned in your git, indexed by specd, enforced by the
            working agreements the setup installs.
          </div>
        </div>
      </section>

      <section className={styles.sec}>
        <div className={styles.in}>
          <span className="tag">03 · AUTOMATION</span>
          <h2 className={styles.h2}>
            The system runs itself. You keep the two decisions that matter.
          </h2>
          <p className={styles.lede}>
            From accepted ticket to merged PR, every mechanical step is automated. Humans hold
            exactly two moments — the approval stamp and the merge button — and both are recorded.
          </p>

          <div className={styles.resp}>
            {(
              [
                ['HUMAN', 'Write the ticket', 'plain business language is enough'],
                ['AUTO', 'Draft the spec — EARS requirements, cited design, sized tasks', 'SpecAgent, full-context'],
                ['HUMAN', 'Approve the spec — the stamp', 'named · versioned · recorded'],
                ['AUTO', 'Build task-by-task, run tests, open PRs', 'under AGENTS.md agreements'],
                ['HUMAN', 'Review & merge the PR', 'your normal code review'],
                ['AUTO', 'File the as-built spec to knowledge/specs/', 'verified on merge, nagged if missing'],
                ['AUTO', 'Re-index knowledge · freshness & staleness flags', 'every merge, every night'],
                ['AUTO', 'Guard — spend caps, scoped tokens, audit trail', 'default-on, kill-switch per project'],
              ] as const
            ).map(([who, what, why]) => (
              <div key={what} className={styles.rrow}>
                <span className={who === 'HUMAN' ? styles.human : styles.auto}>{who}</span>
                <span className={styles.what}>{what}</span>
                <span className={styles.why}>{why}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className={styles.sec}>
        <div className={styles.in}>
          <span className="tag">04 · CONTROL</span>
          <h2 className={styles.h2}>Your infra, your keys, your call</h2>
          <p className={styles.lede}>
            Hosted runners for convenience — or your own runner where your credentials already
            live. Git stays the only source of truth for knowledge; leaving is free.
          </p>
          <div className={styles.term}>
            <div className={styles.termhead}>
              <i />
              <i />
              <i />
              <span>SELF-HOST IN 10 SECONDS</span>
            </div>
            <pre className={styles.termbody}>
              <span className={styles.prompt}>$</span> docker run -d specd/runner --pair XK4-9TR
              {'\n'}
              <span className={styles.ok}>✓ runner paired · outbound-only · creds stay local</span>
              {'\n'}
              <span className={styles.prompt}>$</span> specd spec pull CRM-131{'\n'}
              <span className={styles.ok}>→ spec.md · 5 tasks · feed it to any agent</span>
            </pre>
          </div>
        </div>
      </section>

      <div className={styles.approvedwrap}>
        <p className={styles.approvedmeta}>
          every line of code, traceable to an approved spec · specd v0.1.0 · fair-code · 2026
        </p>
        <div className={styles.approved}>APPROVED.</div>
      </div>

      <footer className={styles.finale}>
        <p className={styles.tiers}>FREE &nbsp;•&nbsp; TEAM &nbsp;•&nbsp; ENTERPRISE</p>
        <div className={styles.finword}>
          spec<span>d</span>
        </div>
        <p className={styles.findesc}>
          EVERY PLAN RUNS THE FULL PIPELINE — KNOWLEDGE BASE,
          <br />
          SPEC GATE, AGENT BUILDS. SEATS ARE ALWAYS FREE;
          <br />
          YOU PAY ONLY FOR AGENT RUNS.
        </p>
        <Link href="/setup" className={styles.finbtn}>
          START YOUR SETUP
        </Link>
        <div className={styles.finmeta}>
          <span>SPECD V0.1 · FAIR-CODE · 2026</span>
        </div>
      </footer>
    </main>
  );
}
