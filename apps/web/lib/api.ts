'use client';

const BASE = process.env.NEXT_PUBLIC_API ?? 'http://localhost:4000/api';
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

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function getUser(): SessionUser | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(USER_KEY);
  return raw ? (JSON.parse(raw) as SessionUser) : null;
}

export function setSession(token: string, user: SessionUser): void {
  window.localStorage.setItem(TOKEN_KEY, token);
  window.localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession(): void {
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(USER_KEY);
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
  return text ? (JSON.parse(text) as T) : (undefined as T);
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
