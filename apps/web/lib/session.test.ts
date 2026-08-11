import { beforeEach, describe, expect, it } from 'vitest';
import { clearSession, getToken, setSession } from './api.js';
import { getSession, tokenExpiry } from './session.js';

/**
 * The rules that decide whether the app believes anyone is signed in. They are
 * worth pinning because both failure directions are user-visible and neither
 * announces itself: too strict signs people out mid-session, too lax offers a
 * dashboard that 401s on every panel behind it.
 */

const USER = { id: 'u1', email: 'a@b.test', name: 'Theo' };

/** A token shaped like the one the API issues — only `exp` is ever read. */
function jwt(claims: Record<string, unknown>): string {
  const b64 = (value: unknown) => {
    // UTF-8 then base64url, the way a real JWT is built — which is what puts
    // multi-byte characters in a payload that `atob` can only hand back as
    // latin1. That is the case the test below is about.
    const utf8 = new TextEncoder().encode(JSON.stringify(value));
    const binary = Array.from(utf8, (byte) => String.fromCharCode(byte)).join('');
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  return `${b64({ alg: 'HS256' })}.${b64(claims)}.not-a-real-signature`;
}

const seconds = (ms: number) => Math.floor((Date.now() + ms) / 1000);

beforeEach(() => {
  window.localStorage.clear();
});

describe('tokenExpiry', () => {
  it('reads exp out of an unpadded base64url payload', () => {
    // The API strips padding, and `exp` is seconds where JS wants ms — get
    // either wrong and every session looks expired, or none ever does.
    const at = seconds(60_000);
    expect(tokenExpiry(jwt({ sub: 'u1', exp: at }))).toBe(at * 1000);
  });

  it('survives a payload carrying a non-ASCII name', () => {
    const at = seconds(60_000);
    expect(tokenExpiry(jwt({ name: 'Jünghwan Päark 박', exp: at }))).toBe(at * 1000);
  });

  it('says nothing rather than guessing when there is no readable exp', () => {
    expect(tokenExpiry('an-opaque-token')).toBeNull();
    expect(tokenExpiry(jwt({ sub: 'u1' }))).toBeNull();
    expect(tokenExpiry('a.!!not-base64!!.c')).toBeNull();
    expect(tokenExpiry('')).toBeNull();
  });
});

describe('getSession', () => {
  it('returns the session while the token is still good', () => {
    setSession(jwt({ sub: 'u1', exp: seconds(7 * 86_400_000) }), USER);
    expect(getSession()).toEqual({ token: getToken(), user: USER });
  });

  it('treats an expired token as signed out, and clears it', () => {
    // Left in place it would pass the shell's front door and then 401 on
    // every request behind it — signed in and broken at the same time.
    setSession(jwt({ sub: 'u1', exp: seconds(-1_000) }), USER);

    expect(getSession()).toBeNull();
    expect(getToken()).toBeNull();
    expect(window.localStorage.getItem('specd.user')).toBeNull();
  });

  it('keeps a token whose expiry it cannot read', () => {
    // Unreadable is not expired. The server is the one that decides, and
    // signing someone out over an unparseable claim would be our error.
    setSession('an-opaque-token', USER);
    expect(getSession()?.user).toEqual(USER);
  });

  it('refuses half a session', () => {
    // A token with nobody to name renders a dashboard belonging to no one.
    setSession(jwt({ sub: 'u1', exp: seconds(60_000) }), USER);
    window.localStorage.removeItem('specd.user');

    expect(getSession()).toBeNull();
    expect(getToken()).toBeNull();
  });

  it('refuses a corrupt user record instead of throwing', () => {
    setSession(jwt({ sub: 'u1', exp: seconds(60_000) }), USER);
    window.localStorage.setItem('specd.user', '{ half-written');

    expect(getSession()).toBeNull();
  });

  it('is null when nobody is signed in', () => {
    clearSession();
    expect(getSession()).toBeNull();
  });

  it('is null under SSR rather than throwing on a missing window', () => {
    const saved = globalThis.window;
    // @ts-expect-error — deliberately simulating the server environment
    delete globalThis.window;
    try {
      expect(getSession()).toBeNull();
    } finally {
      globalThis.window = saved;
    }
  });
});
