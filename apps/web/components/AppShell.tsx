'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { SESSION_EVENT, clearSession, type SessionUser } from '@/lib/api';
import { getSession } from '@/lib/session';
import { Logo } from './Logo';

export function AppShell({
  children,
  crumb,
  pills,
  actions,
}: {
  children: React.ReactNode;
  crumb?: React.ReactNode;
  pills?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [ready, setReady] = useState(false);
  // Leaving on purpose and being thrown out are different journeys: one should
  // not come back to where it was, the other should.
  const leaving = useRef(false);

  useEffect(() => {
    const sync = () => {
      const session = getSession();
      if (session) {
        setUser(session.user);
        setReady(true);
        return;
      }

      // Every way of losing the session ends here — none, expired, or a 401
      // that cleared it mid-visit — so the app has one exit rather than three.
      const here = window.location.pathname + window.location.search;
      router.replace(
        leaving.current || here === '/projects'
          ? '/login'
          : `/login?next=${encodeURIComponent(here)}`,
      );
    };

    sync();
    window.addEventListener(SESSION_EVENT, sync);
    return () => window.removeEventListener(SESSION_EVENT, sync);
  }, [router]);

  if (!ready) {
    return (
      <div className="boot">
        <span className="spinner" />
        <style jsx>{`
          .boot {
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
          }
        `}</style>
      </div>
    );
  }

  const initials =
    user?.name
      .split(/\s+/)
      .map((w) => w[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase() ?? '?';

  return (
    <div className="shell">
      <header className="top">
        <Link href="/projects" className="applogo">
          {/* currentColor: the mark inherits .applogo's ink, no tinting. */}
          <Logo size={20} />
          spec<i>d</i>
        </Link>
        {crumb && <span className="crumb">{crumb}</span>}
        {pills}
        <span className="flex" />
        {actions}
        {/* The wordmark is in-app home; this is the way OUT of the app. The
            dashboard is otherwise a dead end for reaching the site itself. */}
        <Link href="/" className="sitelink" title="specd.dev — the landing page">
          specd.dev
        </Link>
        <button
          type="button"
          className="avatar"
          title={`${user?.name} — sign out`}
          onClick={() => {
            leaving.current = true;
            // Clearing announces itself; the effect above does the navigating,
            // so there is one place that decides where a sessionless app goes.
            clearSession();
          }}
        >
          {initials}
        </button>
      </header>
      <div className="body">{children}</div>

      <style jsx>{`
        .shell {
          min-height: 100vh;
          background: var(--bg);
        }
        .top {
          display: flex;
          align-items: center;
          gap: 0.7rem;
          padding: 0.65rem 1.2rem;
          background: var(--field);
          border-bottom: 1px solid var(--line);
          position: sticky;
          top: 0;
          z-index: 20;
        }
        .crumb {
          font-size: 0.958rem;
          color: var(--ink-2);
        }
        .flex {
          flex: 1;
        }
        /* Scoped here rather than widening the global .applogo — the login
           page uses that class without a mark and keeps its plain layout. */
        .shell :global(.applogo) {
          display: inline-flex;
          align-items: center;
          gap: 0.45rem;
        }
        .shell :global(.sitelink) {
          font: 500 0.845rem/1 var(--mono);
          color: var(--ink-3);
          text-decoration: none;
          padding: 0.3rem 0.45rem;
          border-radius: 6px;
        }
        .shell :global(.sitelink):hover {
          color: var(--ink);
          background: var(--bg-2);
        }
        .avatar {
          width: 1.8rem;
          height: 1.8rem;
          border-radius: 50%;
          border: 1px solid var(--line-2);
          background: var(--panel-2);
          color: var(--ink-2);
          font: 700 0.807rem/1 var(--mono);
          cursor: pointer;
        }
        .avatar:hover {
          border-color: var(--accent);
          color: var(--accent);
        }
        .body {
          max-width: 76rem;
          margin: 0 auto;
          padding: 1.4rem 1.2rem 4rem;
        }
      `}</style>
    </div>
  );
}
