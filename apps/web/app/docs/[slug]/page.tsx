import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import {
  AUDIENCE_LABEL,
  PAGES,
  categoryOf,
  findPage,
  neighbours,
  outline,
  plain,
} from '@/lib/docs';
import { DocBlocks, DocInline } from '@/components/DocBlocks';
import styles from '../docs.module.css';

/** Every doc page is static — the content is a module, not a query. */
export function generateStaticParams() {
  return PAGES.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const page = findPage(slug);
  if (!page) return { title: 'specd — documentation' };
  // `plain` strips the inline markers — a meta description is text, not markup.
  return { title: `${page.title} · specd docs`, description: plain(page.summary) };
}

export default async function DocPageView({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = findPage(slug);
  if (!page) notFound();

  const category = categoryOf(slug);
  const { prev, next } = neighbours(slug);
  const toc = outline(page);

  return (
    <div className={styles.main}>
      <article className={styles.article}>
        <p className={styles.crumb}>
          <Link href="/docs">DOCS</Link>
          {category && <> · {category.title.toUpperCase()}</>}
        </p>
        <h1 className={styles.h1}>{page.title}</h1>
        <p className={styles.lead}>
          <DocInline src={page.summary} />
        </p>
        <div className={styles.meta}>
          <span className={styles.chip}>{AUDIENCE_LABEL[page.audience]}</span>
          <span className={styles.chip}>{page.minutes} min read</span>
        </div>

        {/* The rail duplicates below the header on narrow screens, where the
            right column is gone — a table of contents is most useful exactly
            when the page is long and the viewport is small. */}
        {toc.length > 1 && (
          <details className={styles.tocInline}>
            <summary>On this page</summary>
            <ul>
              {toc.map((h) => (
                <li key={h.id}>
                  <a href={`#${h.id}`}>{h.text}</a>
                </li>
              ))}
            </ul>
          </details>
        )}

        <div className={styles.body}>
          <DocBlocks blocks={page.blocks} />
        </div>

        <nav className={styles.pager} aria-label="More documentation">
          {prev ? (
            <Link href={`/docs/${prev.slug}`} className={styles.pagerprev}>
              <span>PREVIOUS</span>
              <strong>{prev.title}</strong>
            </Link>
          ) : (
            <span />
          )}
          {next && (
            <Link href={`/docs/${next.slug}`} className={styles.pagernext}>
              <span>NEXT</span>
              <strong>{next.title}</strong>
            </Link>
          )}
        </nav>
      </article>

      {toc.length > 1 && (
        <aside className={styles.toc} aria-label="On this page">
          <span className={styles.toctitle}>On this page</span>
          <ul>
            {toc.map((h) => (
              <li key={h.id}>
                <a href={`#${h.id}`}>{h.text}</a>
              </li>
            ))}
          </ul>
          <a
            className={styles.tocedit}
            href="https://github.com/unitypark/specd/tree/main/apps/web/lib/docs"
            target="_blank"
            rel="noreferrer noopener"
          >
            Improve this page →
          </a>
        </aside>
      )}
    </div>
  );
}
