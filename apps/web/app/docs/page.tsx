import Link from 'next/link';
import type { Metadata } from 'next';
import { DOCS, PAGES, AUDIENCE_LABEL } from '@/lib/docs';
import { DocInline } from '@/components/DocBlocks';
import styles from './docs.module.css';

export const metadata: Metadata = {
  title: 'specd — documentation',
  description:
    'How specd turns a ticket into a cited, human-approved spec — and only then lets an agent write code. Start here, core concepts, guides, and the full reference.',
};

/*
 * The docs home. Three jobs, in this order: tell a first-time reader what
 * they are looking at, give them one command they can run, then show the
 * whole map. The map is the point — a documentation index that only lists
 * "popular pages" hides how much is actually here.
 */

const FIRST_STEPS = [
  {
    n: '01',
    title: 'Run it',
    body: 'Clone, install, and one command brings up Postgres, the API and the web app.',
    href: '/docs/quickstart',
    code: 'pnpm demo',
  },
  {
    n: '02',
    title: 'Ground a repository',
    body: 'specd reads your repo and opens a pull request carrying your first knowledge base.',
    href: '/docs/ground-your-repository',
    code: 'review the setup PR',
  },
  {
    n: '03',
    title: 'Approve a spec',
    body: 'A ticket becomes a cited spec. You stamp it, and only then does an agent build.',
    href: '/docs/your-first-spec',
    code: 'specd spec pull <id>',
  },
];

export default function DocsHome() {
  return (
    <div className={`${styles.main} ${styles.mainFull}`}>
      <article className={`${styles.article} ${styles.articleWide}`}>
        <p className={styles.crumb}>DOCS</p>
        <h1 className={styles.h1}>Documentation</h1>
        <p className={styles.lead}>
          specd puts one document between a request and the code: a spec that a named person
          read and approved, with a citation behind every design claim. These pages cover what
          that means, how to run it, and every command and setting it takes.
        </p>

        <div className={styles.meta}>
          <span className={styles.chip}>{PAGES.length} pages</span>
          <span className={styles.chip}>Pre-1.0 · local-first</span>
          <span className={styles.chip}>MIT</span>
        </div>

        <h2 id="start" className={styles.h2}>
          New here? Three steps.
        </h2>
        <div className={styles.first}>
          {FIRST_STEPS.map((s) => (
            <Link key={s.n} href={s.href} className={styles.firstcard}>
              <span className={styles.firstno}>{s.n}</span>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
              <code>{s.code}</code>
            </Link>
          ))}
        </div>

        <h2 id="everything" className={styles.h2}>
          Everything, by category
        </h2>
        <p className={styles.para}>
          Read straight down the left rail if you are new — the order is the order a newcomer
          should meet these ideas. Every page has a reading time and says who it is written for.
        </p>

        {DOCS.map((c) => (
          <section key={c.title} className={styles.catblock}>
            <h3 id={c.title.toLowerCase().replace(/\s+/g, '-')} className={styles.h3}>
              {c.title}
            </h3>
            <p className={styles.catblurb}>{c.blurb}</p>
            <ul className={styles.catlist}>
              {c.pages.map((p) => (
                <li key={p.slug}>
                  <Link href={`/docs/${p.slug}`}>
                    <span className={styles.catname}>{p.title}</span>
                    <span className={styles.catsum}>
                      <DocInline src={p.summary} />
                    </span>
                    <span className={styles.catmeta}>
                      {AUDIENCE_LABEL[p.audience]} · {p.minutes} min
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}

        <h2 id="elsewhere" className={styles.h2}>
          Elsewhere
        </h2>
        <div className={styles.cards}>
          <a
            className={styles.card}
            href="https://github.com/unitypark/specd"
            target="_blank"
            rel="noreferrer noopener"
          >
            <h4>The repository</h4>
            <p>
              Source, issues, the README, and specd&rsquo;s own knowledge base under{' '}
              <code>knowledge/</code>.
            </p>
          </a>
          <a
            className={styles.card}
            href="https://github.com/unitypark/specd/blob/main/CONTRIBUTING.md"
            target="_blank"
            rel="noreferrer noopener"
          >
            <h4>Contributing</h4>
            <p>
              The verify gate is <code>pnpm typecheck &amp;&amp; pnpm test</code> — CI runs exactly
              that.
            </p>
          </a>
          <a
            className={styles.card}
            href="https://github.com/unitypark/specd/blob/main/SECURITY.md"
            target="_blank"
            rel="noreferrer noopener"
          >
            <h4>Security</h4>
            <p>How to report a vulnerability, and what specd enforces in code.</p>
          </a>
        </div>
      </article>
    </div>
  );
}
