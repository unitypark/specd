'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { post, setSession, type SessionUser } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const path = mode === 'login' ? '/auth/login' : '/auth/register';
      const body = mode === 'login' ? { email, password } : { email, name, password };
      const res = await post<{ token: string; user: SessionUser }>(path, body);
      setSession(res.token, res.user);
      router.push('/projects');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="wrap">
      <Link href="/" className="applogo lg">
        spec<i>d</i>
      </Link>

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
        .full {
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
