'use client';

export const API_BASE = process.env.NEXT_PUBLIC_API ?? 'http://localhost:4000/api';
const BASE = API_BASE;
const TOKEN_KEY = 'specd.token';
const USER_KEY = 'specd.user';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/**
 * Fired on the window whenever the stored session appears or disappears.
 * Views subscribe to it so they all agree about who is signed in: a nav still
 * offering SIGN IN to someone who just signed in is how people sign in twice.
 */
export const SESSION_EVENT = 'specd:session';

function announceSessionChange(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SESSION_EVENT));
}

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function getUser(): SessionUser | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionUser;
  } catch {
    // A truncated or hand-edited value is not a session. Throwing would take
    // down every page that only wanted to know whether to show a sign-in link.
    return null;
  }
}

export function setSession(token: string, user: SessionUser): void {
  window.localStorage.setItem(TOKEN_KEY, token);
  window.localStorage.setItem(USER_KEY, JSON.stringify(user));
  announceSessionChange();
}

export function clearSession(): void {
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(USER_KEY);
  announceSessionChange();
}

export async function api<T = unknown>(
  path: string,
  init: RequestInit & { raw?: boolean } = {},
): Promise<T> {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });

  const text = await res.text();

  if (!res.ok) {
    // A 401 on a request that carried a token means that token is no longer
    // good — expired, revoked, or signed with a secret that has since rotated.
    // Keeping it is how "you are signed in" and "everything fails" coexist,
    // so it goes, and the event sends whoever is watching back to sign in.
    if (res.status === 401 && token) clearSession();

    let message = text;
    let code: string | undefined;
    try {
      const parsed = JSON.parse(text) as { message?: string | string[]; error?: string };
      code = parsed.error;
      message = Array.isArray(parsed.message)
        ? parsed.message.join('; ')
        : (parsed.message ?? text);
    } catch {
      // Non-JSON error body — show it as-is rather than swallowing it.
    }
    throw new ApiError(res.status, message, code);
  }

  if (init.raw) return text as T;
  if (!text) return undefined as T;

  try {
    return JSON.parse(text) as T;
  } catch {
    // A 2xx whose body is not JSON did not come from this API. Something
    // answered in its place — a dev server on the same port, a proxy, an SSO
    // portal serving its login page at 200. `JSON.parse` reports that as
    // "Unexpected token '<', \"<!DOCTYPE \"...", which describes the first
    // character of the problem and none of the rest of it.
    throw new ApiError(
      res.status,
      `${BASE}${path} answered ${res.status} with ${looksLikeHtml(text) ? 'an HTML page' : 'a non-JSON body'} ` +
        'instead of JSON, so it is not specd\'s API answering. Check that the API is running and ' +
        `that NEXT_PUBLIC_API points at it (currently ${BASE}).`,
    );
  }
}

function looksLikeHtml(body: string): boolean {
  const head = body.trimStart().slice(0, 200).toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html');
}

export const get = <T>(path: string) => api<T>(path);
export const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
export const patch = <T>(path: string, body: unknown) =>
  api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' });

/**
 * SSE with an Authorization header — EventSource cannot send one, so the run
 * log stream is read from a fetch body instead.
 */
export async function streamRun(
  slug: string,
  runId: string,
  onLine: (line: { at?: string; level?: string; message?: string; type?: string; status?: string }) => void,
  signal?: AbortSignal,
): Promise<void> {
  const token = getToken();
  const res = await fetch(`${BASE}/projects/${slug}/runs/${runId}/stream`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal,
  });
  if (!res.body) return;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          onLine(JSON.parse(line.slice(5).trim()));
        } catch {
          // A partial frame is not an error; the next chunk completes it.
        }
      }
    }
  }
}
