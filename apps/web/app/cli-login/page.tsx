'use client';

import { useState } from 'react';
import { post } from '@/lib/api';
import { AppShell } from '@/components/AppShell';

/**
 * The browser half of the CLI device flow. A machine cannot mint itself a
 * token — a signed-in human confirms the code here, and only then does the
 * CLI get one (§9).
 */
export default function CliLoginPage() {
  const [code, setCode] = useState('');
  const [state, setState] = useState<'idle' | 'ok' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function approve(e: React.FormEvent) {
    e.preventDefault();
    // Guards the double-submit a slow response invites; codes are single-use,
    // so the second click would burn the very code being confirmed.
    if (busy) return;
    setBusy(true);
    setState('idle');
    try {
      await post('/auth/device/approve', { userCode: code.trim().toUpperCase() });
      setState('ok');
    } catch (err) {
      setState('error');
      setMessage(err instanceof Error ? err.message : 'Could not confirm that code');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell crumb="Authorize a device">
      <div className="narrow">
        <h1>Authorize the specd CLI</h1>
        <p className="sub">
          Running <code>specd login</code> printed a code. Type it here to grant that machine a
          short-lived, read-only token.
        </p>

        {state === 'ok' ? (
          <div className="done card">
            <span className="tick">✓</span>
            <div>
              <b>Device authorized.</b>
              <p>You can go back to your terminal — the CLI has its token.</p>
            </div>
          </div>
        ) : (
          <form onSubmit={approve} className="card">
            <div className="field">
              <label htmlFor="code">Device code</label>
              <input
                id="code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="XKF4-9TR2"
                autoFocus
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            {state === 'error' && <div className="err">{message}</div>}
            <button type="submit" className="btn primary" disabled={busy || code.trim().length < 4}>
              {busy ? <span className="spinner" /> : 'Authorize this device'}
            </button>
            <p className="note">
              The CLI can read approved specs and register repositories. It cannot approve a spec —
              that stays here, with you.
            </p>
          </form>
        )}
      </div>

      <style jsx>{`
        .narrow {
          max-width: 30rem;
        }
        h1 {
          font: 600 1.35rem/1.2 var(--serif);
          margin: 0 0 0.4rem;
        }
        .sub {
          color: var(--ink-2);
          font-size: 0.84rem;
          line-height: 1.7;
          margin: 0 0 1.4rem;
        }
        .note {
          color: var(--ink-3);
          font-size: 0.74rem;
          line-height: 1.6;
          margin: 1rem 0 0;
        }
        .done {
          display: flex;
          gap: 0.9rem;
          align-items: flex-start;
        }
        .tick {
          color: var(--accent);
          font-size: 1.4rem;
          line-height: 1;
        }
        .done b {
          font-family: var(--serif);
          font-size: 1rem;
        }
        .done p {
          color: var(--ink-2);
          font-size: 0.82rem;
          margin: 0.3rem 0 0;
        }
      `}</style>
    </AppShell>
  );
}
