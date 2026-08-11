'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { clearSession, getToken, getUser, type SessionUser } from '@/lib/api';
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

  useEffect(() => {
    if (!getToken()) {
      router.replace('/login');
      return;
    }
    setUser(getUser());
    setReady(true);
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
            clearSession();
            router.push('/login');
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
