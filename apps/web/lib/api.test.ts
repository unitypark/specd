import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, clearSession, getToken, getUser, setSession, streamRun } from './api.js';

/**
 * Every view in the app talks to the server through this module, so its edges
 * are the app's edges: whether a request carries the session, and whether an
 * error the server sent arrives as something a person can read.
 */

const BASE = 'http://localhost:4000/api';

function mockFetch(response: {
  ok?: boolean;
  status?: number;
  body?: string;
}): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => ({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    text: async () => response.body ?? '',
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** A body that arrives in pieces, the way a real stream does. */
function streamOf(chunks: string[]) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    getReader: () => ({
      read: async () =>
        i < chunks.length
          ? { done: false, value: encoder.encode(chunks[i++]) }
          : { done: true, value: undefined },
    }),
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('session', () => {
  it('round-trips a session and clears it completely', () => {
    setSession('tok-1', { id: 'u1', email: 'a@b.test', name: 'Theo' });
    expect(getToken()).toBe('tok-1');
    expect(getUser()).toEqual({ id: 'u1', email: 'a@b.test', name: 'Theo' });

    clearSession();
    expect(getToken()).toBeNull();
    expect(getUser()).toBeNull();
  });

  it('returns null under SSR instead of throwing on a missing window', () => {
    // These run during Next's server render too, where there is no
    // localStorage at all — returning null is what keeps the app rendering.
    const saved = globalThis.window;
    // @ts-expect-error — deliberately simulating the server environment
    delete globalThis.window;
    try {
      expect(getToken()).toBeNull();
      expect(getUser()).toBeNull();
    } finally {
      globalThis.window = saved;
    }
  });
});

describe('api()', () => {
  it('sends the bearer token when there is a session', async () => {
    setSession('tok-1', { id: 'u1', email: 'a@b.test', name: 'Theo' });
    const fetchMock = mockFetch({ body: '{"ok":true}' });

    await api('/projects');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/projects`);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
  });

  it('omits the Authorization header entirely when signed out', async () => {
    const fetchMock = mockFetch({ body: '{}' });
    await api('/health');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('sets Content-Type only when there is a body to describe', async () => {
    const fetchMock = mockFetch({ body: '{}' });

    await api('/tickets', { method: 'POST', body: JSON.stringify({ title: 'x' }) });
    await api('/tickets');

    const withBody = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    const without = (fetchMock.mock.calls[1] as [string, RequestInit])[1];
    expect((withBody.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect((without.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('joins a validation error array into one readable sentence', async () => {
    // Nest's ValidationPipe returns `message` as an array of field errors.
    // Rendering that raw would show a user "[object Object]" or a bare array.
    mockFetch({
      ok: false,
      status: 400,
      body: JSON.stringify({ message: ['name must be longer', 'slug is required'], error: 'Bad Request' }),
    });

    await expect(api('/projects', { method: 'POST', body: '{}' })).rejects.toMatchObject({
      status: 400,
      message: 'name must be longer; slug is required',
      code: 'Bad Request',
    });
  });

  it('surfaces a single-string error message and its code', async () => {
    mockFetch({ ok: false, status: 409, body: JSON.stringify({ message: 'Spec is not approved', error: 'Conflict' }) });

    const err = await api('/specs/1/build', { method: 'POST' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe('Spec is not approved');
    expect((err as ApiError).status).toBe(409);
  });

  it('shows a non-JSON error body as-is rather than swallowing it', async () => {
    // A proxy 502 or an HTML error page is exactly when a user most needs to
    // see what actually came back.
    mockFetch({ ok: false, status: 502, body: '<html>Bad Gateway</html>' });

    await expect(api('/projects')).rejects.toMatchObject({
      status: 502,
      message: '<html>Bad Gateway</html>',
    });
  });

  it('returns raw text when asked, and undefined for an empty body', async () => {
    mockFetch({ body: '# a spec in markdown' });
    expect(await api('/specs/1/pull', { raw: true })).toBe('# a spec in markdown');

    mockFetch({ body: '' });
    expect(await api('/runners/1', { method: 'DELETE' })).toBeUndefined();
  });
});

describe('streamRun()', () => {
  it('reassembles frames split across chunk boundaries', async () => {
    // The reason this function exists instead of EventSource is the auth
    // header, and the reason it needs a buffer is that a chunk boundary can
    // land mid-frame. Splitting one JSON line in half proves it.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        body: streamOf(['data: {"message":"clon', 'ing acme/repo"}\n\ndata: {"message":"done"}\n\n']),
      })),
    );

    const lines: { message?: string }[] = [];
    await streamRun('aurora', 'run-1', (line) => lines.push(line));

    expect(lines).toEqual([{ message: 'cloning acme/repo' }, { message: 'done' }]);
  });

  it('ignores comments and keep-alives, and survives an unparseable frame', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        body: streamOf([': keep-alive\n\n', 'data: not json\n\n', 'data: {"status":"succeeded"}\n\n']),
      })),
    );

    const lines: { status?: string }[] = [];
    await expect(streamRun('aurora', 'run-1', (line) => lines.push(line))).resolves.toBeUndefined();
    expect(lines).toEqual([{ status: 'succeeded' }]);
  });

  it('sends the session token on the stream request', async () => {
    setSession('tok-9', { id: 'u1', email: 'a@b.test', name: 'Theo' });
    const fetchMock = vi.fn(async () => ({ body: streamOf([]) }));
    vi.stubGlobal('fetch', fetchMock);

    await streamRun('aurora', 'run-1', () => undefined);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/projects/aurora/runs/run-1/stream`);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-9');
  });

  it('returns quietly when the response has no body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ body: null })));
    await expect(streamRun('aurora', 'run-1', () => undefined)).resolves.toBeUndefined();
  });
});
