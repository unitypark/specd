import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { clearSession, setSession } from '@/lib/api';
import { AuthLink } from './AuthLink';

/**
 * The control at the centre of "I am signed in and it keeps asking me to sign
 * in". Rendered for real, because the bug it fixes is not in the logic below
 * it — that is tested in lib/session.test.ts — but in what a person ends up
 * looking at.
 */

const USER = { id: 'u1', email: 'a@b.test', name: 'Theo' };
const FRESH_TOKEN = (() => {
  const b64 = (v: unknown) =>
    btoa(JSON.stringify(v)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
})();

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  // The component subscribes to session events for its whole life. A root left
  // mounted keeps listening through the next test and reacts to its setup,
  // which surfaces as React complaining about updates outside act().
  act(() => root.unmount());
  container.remove();
});

function render() {
  act(() => {
    root.render(<AuthLink className="nav" signInLabel="SIGN IN" dashboardLabel="DASHBOARD" />);
  });
  return container.querySelector('a')!;
}

describe('AuthLink', () => {
  it('offers the dashboard, not a sign-in prompt, to someone signed in', () => {
    setSession(FRESH_TOKEN, USER);

    const link = render();
    expect(link.textContent).toBe('DASHBOARD');
    expect(link.getAttribute('href')).toBe('/projects');
    expect(link.style.visibility).toBe('');
  });

  it('offers sign-in to a visitor', () => {
    clearSession();

    const link = render();
    expect(link.textContent).toBe('SIGN IN');
    expect(link.getAttribute('href')).toBe('/login');
    expect(link.style.visibility).toBe('');
  });

  it('follows a session that changes while the page is open', () => {
    // Sign out in another tab, or a 401 clearing a dead token mid-visit: the
    // link has to notice, or it goes on pointing at an app you are out of.
    setSession(FRESH_TOKEN, USER);
    const link = render();
    expect(link.textContent).toBe('DASHBOARD');

    act(() => {
      clearSession();
    });
    expect(container.querySelector('a')!.textContent).toBe('SIGN IN');
  });
});
