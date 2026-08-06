import Link from 'next/link';
import type { Metadata } from 'next';
import { LandingNav } from '@/components/LandingNav';
import styles from '../landing.module.css';

export const metadata: Metadata = { title: 'specd — docs' };

const QUICKSTART = [
  'Start your setup → wizard: connect code + AI + tracker',
  'Review the setup PRs → merging = adopting (knowledge/ + AGENTS.md land in each repo)',
  'Pick a ticket → Generate spec → team reviews → a named human APPROVES',
  'Build → hosted runner — or locally: specd spec pull <id>',
  'Merge the PR → the as-built spec files itself · knowledge re-indexes',
];

const CONCEPTS: [string, string][] = [
  ['knowledge/', 'per-repo wiki the agent must read first — git is the only source of truth'],
  ['AGENTS.md', 'working agreements installed by setup; CLAUDE.md imports it'],
  ['spec', 'EARS requirements · cited design · tasks ≤ 1 PR · versions append-only'],
  ['the gate', 'a named human approves every spec — recorded, structural, unskippable'],
  ['as-built', 'last task of every spec: file it to knowledge/specs/ — context compounds'],
];

const CLI: [string, string][] = [
  ['specd login', 'device-code auth — token lives in your OS keychain'],
  ['specd connect', 'register the current local repo (runner mode)'],
  ['specd spec pull <id>', 'fetch a spec for any coding agent — approved only, the gate is server-side'],
  ['specd spec status <id>', 'exit 0 approved · 3 not approved — the CI gate'],
  ['specd open', 'open the project in the web app'],
];

export default function Docs() {
  return (
    <main className={styles.page}>
      <LandingNav />
      <section className={styles.subhead}>
        <div className={styles.subin}>
          <Link href="/" className={styles.back}>
            ← BACK TO SITE
          </Link>
          <span className="tag">DOCS</span>
          <h1 className={styles.subh1}>Documentation</h1>
          <p className={styles.lede}>
            The five-minute version — enough to run the loop. Full reference ships with P1.
          </p>

          <span className="tag">QUICKSTART</span>
          <div className={`${styles.rows} ${styles.qs}`} style={{ marginTop: '.6rem' }}>
            {QUICKSTART.map((step) => (
              <div key={step} className={styles.row}>
                <span className={styles.step} />
                <span>{step}</span>
              </div>
            ))}
          </div>

          <span className="tag">CORE CONCEPTS</span>
          <div className={styles.rows} style={{ marginTop: '.6rem' }}>
            {CONCEPTS.map(([term, meaning]) => (
              <div key={term} className={styles.row}>
                <code>{term}</code>
                <span>{meaning}</span>
              </div>
            ))}
          </div>

          <span className="tag">CLI</span>
          <div className={styles.rows} style={{ marginTop: '.6rem' }}>
            {CLI.map(([cmd, meaning]) => (
              <div key={cmd} className={styles.row}>
                <code>{cmd}</code>
                <span>{meaning}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
