'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMemo, useState } from 'react';
import { DOCS } from '@/lib/docs';
import styles from '../app/docs/docs.module.css';

/*
 * The left rail.
 *
 * A filter box rather than a search index: with ~25 pages, matching a typed
 * string against titles and summaries finds the page in one keystroke, and it
 * costs no index, no dependency and nothing at build time. A real search over
 * body text would be a different feature and should not be faked by a box
 * that only looks like one — so the placeholder says "filter", not "search".
 */
export function DocsSidebar() {
  const pathname = usePathname();
  const [q, setQ] = useState('');
  // Closed by default on mobile, where the rail is a drawer. Irrelevant above
  // the breakpoint, where CSS keeps it open regardless.
  const [open, setOpen] = useState(false);

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return DOCS;
    return DOCS.map((c) => ({
      ...c,
      pages: c.pages.filter(
        (p) =>
          p.title.toLowerCase().includes(needle) ||
          p.summary.toLowerCase().includes(needle) ||
          c.title.toLowerCase().includes(needle),
      ),
    })).filter((c) => c.pages.length > 0);
  }, [q]);

  return (
    <>
      <button
        type="button"
        className={styles.navtoggle}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? '✕ CLOSE' : '☰ ALL DOCS'}
      </button>

      <nav
        className={`${styles.sidebar} ${open ? styles.sidebarOpen : ''}`}
        aria-label="Documentation"
      >
        <input
          className={styles.filter}
          type="search"
          value={q}
          placeholder="Filter pages…"
          aria-label="Filter documentation pages"
          onChange={(e) => setQ(e.target.value)}
        />

        {groups.map((c) => (
          <div key={c.title} className={styles.navgroup}>
            <span className={styles.navtitle}>{c.title}</span>
            <ul>
              {c.pages.map((p) => {
                const href = `/docs/${p.slug}`;
                const active = pathname === href;
                return (
                  <li key={p.slug}>
                    <Link
                      href={href}
                      className={active ? styles.navlinkOn : styles.navlink}
                      aria-current={active ? 'page' : undefined}
                      onClick={() => setOpen(false)}
                    >
                      {p.title}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}

        {groups.length === 0 && <p className={styles.navempty}>No page matches “{q}”.</p>}
      </nav>
    </>
  );
}
