import Link from 'next/link';
import { Fragment } from 'react';
import { anchor, headingText, inline, type Block, type Inline } from '@/lib/docs';
import styles from '../app/docs/docs.module.css';

/*
 * The React half of the two renderers over `lib/docs`. The other half is
 * `scripts/site/render.ts`, which turns the same blocks into static HTML for
 * the published site. When a block kind is added here it has to be added
 * there too — `lib/docs/docs.test.ts` asserts every block kind in the corpus
 * is one both renderers know, so the failure shows up as a red test rather
 * than as a silently empty section on the public site.
 */

/** One string of inline markup, rendered. Exported because page summaries are
 *  written in the same syntax and appear outside the block flow. */
export function DocInline({ src }: { src: string }) {
  return (
    <>
      {inline(src).map((t: Inline, i) => {
        switch (t.t) {
          case 'code':
            return <code key={i}>{t.v}</code>;
          case 'strong':
            return <strong key={i}>{t.v}</strong>;
          case 'em':
            return <em key={i}>{t.v}</em>;
          case 'link':
            // Internal links go through next/link so a docs-to-docs hop is a
            // client navigation; anything with a scheme is somebody else's site
            // and opens in a new tab.
            return t.href.startsWith('/') || t.href.startsWith('#') ? (
              <Link key={i} href={t.href}>
                {t.v}
              </Link>
            ) : (
              <a key={i} href={t.href} target="_blank" rel="noreferrer noopener">
                {t.v}
              </a>
            );
          default:
            return <Fragment key={i}>{t.v}</Fragment>;
        }
      })}
    </>
  );
}

function One({ b }: { b: Block }) {
  switch (b.k) {
    case 'lead':
      return (
        <p className={styles.lead}>
          <DocInline src={b.text} />
        </p>
      );

    case 'p':
      return (
        <p>
          <DocInline src={b.text} />
        </p>
      );

    case 'h2':
      // The id is what the right-hand rail scrolls to, and what a shared link
      // lands on. Generated from the text so the two can never disagree.
      return (
        <h2 id={anchor(headingText(b.text))} className={styles.h2}>
          {headingText(b.text)}
        </h2>
      );

    case 'h3':
      return (
        <h3 id={anchor(headingText(b.text))} className={styles.h3}>
          {headingText(b.text)}
        </h3>
      );

    case 'ul':
      return (
        <ul className={styles.ul}>
          {b.items.map((it, i) => (
            <li key={i}>
              <DocInline src={it} />
            </li>
          ))}
        </ul>
      );

    case 'ol':
      return (
        <ol className={styles.ol}>
          {b.items.map((it, i) => (
            <li key={i}>
              <DocInline src={it} />
            </li>
          ))}
        </ol>
      );

    case 'dl':
      return (
        <dl className={styles.dl}>
          {b.items.map((it, i) => (
            <div key={i}>
              <dt>
                <DocInline src={it.term} />
              </dt>
              <dd>
                <DocInline src={it.text} />
              </dd>
            </div>
          ))}
        </dl>
      );

    case 'code':
      return (
        <figure className={styles.codeblock}>
          {b.caption && <figcaption>{b.caption}</figcaption>}
          <pre>
            <code>{b.code}</code>
          </pre>
        </figure>
      );

    case 'table':
      return (
        // The wrapper, not the table, is what scrolls: a wide reference table
        // must not make the whole page scroll sideways on a phone.
        <div className={styles.tablewrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                {b.head.map((h, i) => (
                  <th key={i}>
                    <DocInline src={h} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j}>
                      <DocInline src={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    case 'note':
      return (
        <aside className={`${styles.note} ${styles[`note_${b.tone}`]}`}>
          {b.title && (
            <strong>
              <DocInline src={b.title} />
            </strong>
          )}
          <p>
            <DocInline src={b.text} />
          </p>
        </aside>
      );

    case 'steps':
      return (
        <ol className={styles.steps}>
          {b.items.map((it, i) => (
            <li key={i}>
              <h4>
                <DocInline src={it.title} />
              </h4>
              <p>
                <DocInline src={it.text} />
              </p>
            </li>
          ))}
        </ol>
      );

    case 'cards':
      return (
        <div className={styles.cards}>
          {b.items.map((it, i) => {
            const body = (
              <>
                <h4>
                  <DocInline src={it.title} />
                </h4>
                <p>
                  <DocInline src={it.text} />
                </p>
              </>
            );
            return it.href ? (
              <Link key={i} href={it.href} className={styles.card}>
                {body}
              </Link>
            ) : (
              <div key={i} className={styles.card}>
                {body}
              </div>
            );
          })}
        </div>
      );

    case 'quote':
      return (
        <blockquote className={styles.quote}>
          <p>
            <DocInline src={b.text} />
          </p>
          {b.cite && <cite>{b.cite}</cite>}
        </blockquote>
      );
  }
}

export function DocBlocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((b, i) => (
        <One key={i} b={b} />
      ))}
    </>
  );
}
