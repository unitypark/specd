'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { clearSession, post, setSession, type SessionUser } from '@/lib/api';
import { useSession } from '@/lib/session';

/**
 * Where to go once signed in. Only a path on this site is accepted: `next`
 * arrives from a URL anyone can write, and an open redirect is how a sign-in
 * page ends up delivering people to someone else's.
 */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/projects';
  return raw;
}

export default function LoginPage() {
  // useSearchParams needs a Suspense boundary for prerendering.
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const session = useSession();
  const next = safeNext(useSearchParams().get('next'));
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Someone signed in who came here anyway may have meant to switch accounts.
  // They get the form when they say so, not before.
  const [switching, setSwitching] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const path = mode === 'login' ? '/auth/login' : '/auth/register';
      const body = mode === 'login' ? { email, password } : { email, name, password };
      const res = await post<{ token: string; user: SessionUser }>(path, body);
      setSession(res.token, res.user);
      router.push(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  // Already signed in: say so and open the door, rather than ask a question
  // that was answered days ago.
  const signedIn = session.status === 'authed' && !switching;

  return (
    <main className="wrap">
      <Link href="/" className="applogo lg">
        spec<i>d</i>
      </Link>

      {signedIn ? (
        <div className="card box">
          <h1>You are already signed in</h1>
          <p className="sub">
            as <b>{session.user.name}</b> — {session.user.email}
          </p>

          <Link href={next} className="btn primary full">
            Continue to specd
          </Link>

          <button
            type="button"
            className="switch"
            onClick={() => {
              clearSession();
              setSwitching(true);
            }}
          >
            Sign in as someone else
          </button>
        </div>
      ) : (
        <div className="card box">
          <h1>{mode === 'login' ? 'Sign in' : 'Create an account'}</h1>
          <p className="sub">
            {mode === 'login'
              ? 'Reviewers never cost a seat — that is how the gate stays real.'
              : 'You will own the first project you create.'}
          </p>

          <form onSubmit={submit}>
            {mode === 'register' && (
              <div className="field">
                <label htmlFor="name">Name</label>
                <input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  autoComplete="name"
                />
                <span className="hint">This is the name recorded on every approval you make.</span>
              </div>
            )}

            <div className="field">
              <label htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </div>

            <div className="field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              />
              {mode === 'register' && <span className="hint">At least 8 characters.</span>}
            </div>

            {error && <div className="err">{error}</div>}

            <button type="submit" className="btn primary full" disabled={busy}>
              {busy ? <span className="spinner" /> : mode === 'login' ? 'Sign in' : 'Create account'}
            </button>
          </form>

          <button
            type="button"
            className="switch"
            onClick={() => {
              setMode(mode === 'login' ? 'register' : 'login');
              setError(null);
            }}
          >
            {mode === 'login' ? 'Need an account? Create one' : 'Already have an account? Sign in'}
          </button>
        </div>
      )}

      <style jsx>{`
        .wrap {
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 1.6rem;
          padding: 2rem;
          background: var(--field);
        }
        .box {
          width: 100%;
          max-width: 24rem;
          padding: 1.6rem 1.6rem 1.2rem;
        }
        h1 {
          font: 600 1.2rem/1.2 var(--serif);
          margin: 0 0 0.35rem;
        }
        .sub {
          color: var(--ink-3);
          font-size: 0.78rem;
          line-height: 1.6;
          margin: 0 0 1.3rem;
        }
        /* The second selector is for the anchor form of the same button: a
           <Link> is a component, not an element, so the scoped class is not
           guaranteed to reach the <a> it renders. */
        .full,
        .box :global(.btn.full) {
          width: 100%;
          padding: 0.7rem;
        }
        .switch {
          display: block;
          width: 100%;
          margin-top: 1rem;
          background: none;
          border: none;
          color: var(--ink-3);
          font: 500 0.75rem/1 var(--sans);
          cursor: pointer;
        }
        .switch:hover {
          color: var(--accent);
        }
      `}</style>
    </main>
  );
}
