'use client';

import { useEffect, useState } from 'react';
import { SESSION_EVENT, clearSession, getToken, getUser, type SessionUser } from './api';

/**
 * Who is signed in — one answer, used by the marketing pages, the login page
 * and the app shell alike.
 *
 * Three views deciding this three ways is what produced the bug this exists to
 * kill: a signed-in person being offered "Sign in" on the landing page, and a
 * long-expired token still passing the shell's front door only to 401 on every
 * panel behind it. The rule here is that a session is a token that has not
 * expired *and* a user to name — anything else is signed out, and is cleared
 * on the spot rather than left to fail later.
 */

export interface Session {
  token: string;
  user: SessionUser;
}

export type SessionState =
  | { status: 'loading'; user: null }
  | { status: 'authed'; user: SessionUser }
  | { status: 'anon'; user: null };

/**
 * When the token expires, in ms since the epoch — or null if it does not say.
 *
 * The claim is read, not verified: the server checks the signature, and a
 * client fooled by a forged token would only be lying to itself about which
 * button to draw. Only `exp` is read, so the latin1 that `atob` returns for a
 * payload containing a non-ASCII name is harmless — the number is ASCII either
 * way.
 */
export function tokenExpiry(token: string): number | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as {
      exp?: unknown;
    };
    return typeof claims.exp === 'number' ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * The stored session, or null. Reads `window`, so it is null during SSR — call
 * it from an effect, never from a render, or the server and the client will
 * disagree about the markup they just produced.
 */
export function getSession(): Session | null {
  const token = getToken();
  if (!token) return null;

  const expiry = tokenExpiry(token);
  // A token with no readable expiry is left alone: unreadable is not the same
  // as expired, and the server is the one that decides anyway.
  if (expiry !== null && expiry <= Date.now()) {
    clearSession();
    return null;
  }

  const user = getUser();
  if (!user) {
    // Half a session is not a session. The shell has nobody to name and the
    // nav has nothing to link to, so treat it as signed out rather than
    // render a dashboard belonging to no one.
    clearSession();
    return null;
  }

  return { token, user };
}

/**
 * The session as a piece of React state, starting at `loading` because nothing
 * is knowable until the component mounts on the client. Callers that render a
 * prompt should wait for that: offering "Sign in" while still looking is a
 * smaller version of the same bug.
 */
export function useSession(): SessionState {
  const [state, setState] = useState<SessionState>({ status: 'loading', user: null });

  useEffect(() => {
    const sync = () => {
      const session = getSession();
      setState(session ? { status: 'authed', user: session.user } : { status: 'anon', user: null });
    };

    sync();
    window.addEventListener(SESSION_EVENT, sync);
    // Signing out in one tab must not leave another tab looking signed in.
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(SESSION_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  return state;
}
