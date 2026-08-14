import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitLabAdapter } from './gitlab.adapter.js';

/**
 * Against a stubbed transport, not a live instance — the same arrangement as
 * `github.adapter.test.ts`, and covering the method the two adapters are meant
 * to agree on.
 *
 * `openMergeRequest` is tested directly rather than through `propose` because
 * `propose` deletes and recreates the setup branch, which takes the open MR
 * with it: the already-open case is reachable from the build station, which
 * pushes to the branch instead. That asymmetry is recorded in
 * `knowledge/decisions/0016-onboarding-runs-are-queued.md`.
 */

const NAME = 'acme/aurora-api';
const ID = encodeURIComponent(NAME);

const mr = {
  branch: 'specd/build-S-101',
  base: 'main',
  title: 'S-101: reclaim jobs abandoned by a dead runner',
  body: '`pnpm test` **failed**. The branch is here for you to inspect.',
};

/** Routes by `METHOD /path`; a `null` route stands for a non-2xx. */
function stub(routes: Record<string, unknown | null>) {
  const calls: string[] = [];
  const sent: { key: string; body: unknown }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = url.replace('https://gitlab.com/api/v4', '');
    const key = `${init.method ?? 'GET'} ${path}`;
    calls.push(key);
    if (init.body) sent.push({ key, body: JSON.parse(String(init.body)) });

    if (!Object.hasOwn(routes, key)) throw new Error(`unstubbed request: ${key}`);

    const body = routes[key];
    const ok = body !== null;

    return {
      ok,
      status: ok ? 200 : 409,
      statusText: 'stubbed',
      json: async () => body ?? {},
      text: async () => JSON.stringify(body ?? { message: ['Another open merge request already exists'] }),
    };
  });
  vi.stubGlobal('fetch', fn);
  return { calls, sent };
}

const adapter = () => new GitLabAdapter('tok-123');
const OPEN_FOR_BRANCH = `GET /projects/${ID}/merge_requests?source_branch=specd%2Fbuild-S-101&state=opened`;

afterEach(() => vi.unstubAllGlobals());

describe('openMergeRequest', () => {
  it('opens one when the branch has none', async () => {
    const { sent } = stub({
      [`POST /projects/${ID}/merge_requests`]: {
        web_url: 'https://gitlab.com/acme/aurora-api/-/merge_requests/9',
        iid: 9,
      },
    });

    const opened = await adapter().openMergeRequest(NAME, mr);

    expect(opened).toEqual({
      url: 'https://gitlab.com/acme/aurora-api/-/merge_requests/9',
      number: 9,
      existing: false,
      descriptionStale: false,
    });
    expect(sent[0]?.body).toMatchObject({ source_branch: mr.branch, target_branch: 'main' });
  });

  it('rewrites the open one rather than opening a second', async () => {
    const { calls, sent } = stub({
      [`POST /projects/${ID}/merge_requests`]: null,
      [OPEN_FOR_BRANCH]: [
        { web_url: 'https://gitlab.com/acme/aurora-api/-/merge_requests/4', iid: 4 },
      ],
      [`PUT /projects/${ID}/merge_requests/4`]: { iid: 4 },
    });

    const opened = await adapter().openMergeRequest(NAME, mr);

    expect(opened).toEqual({
      url: 'https://gitlab.com/acme/aurora-api/-/merge_requests/4',
      number: 4,
      existing: true,
      descriptionStale: false,
    });
    // A build re-run states a fresh commit count and verify result. Left at the
    // previous run's text, an MR whose verify now fails still reads "passed".
    expect(sent.find((s) => s.key === `PUT /projects/${ID}/merge_requests/4`)?.body).toEqual({
      title: mr.title,
      description: mr.body,
    });
    expect(calls).toContain(OPEN_FOR_BRANCH);
  });

  it('reports a description it could not rewrite instead of failing the run', async () => {
    stub({
      [`POST /projects/${ID}/merge_requests`]: null,
      [OPEN_FOR_BRANCH]: [
        { web_url: 'https://gitlab.com/acme/aurora-api/-/merge_requests/4', iid: 4 },
      ],
      [`PUT /projects/${ID}/merge_requests/4`]: null,
    });

    await expect(adapter().openMergeRequest(NAME, mr)).resolves.toMatchObject({
      number: 4,
      existing: true,
      descriptionStale: true,
    });
  });

  it('still fails when the refusal was not "one is already open"', async () => {
    // Nothing open for the branch means the error was something else, and
    // reporting a review surface that does not exist is worse than failing.
    stub({
      [`POST /projects/${ID}/merge_requests`]: null,
      [OPEN_FOR_BRANCH]: [],
    });

    await expect(adapter().openMergeRequest(NAME, mr)).rejects.toThrow(/merge_requests/);
  });
});

describe('construction', () => {
  it('refuses to exist without a token, naming the fix', () => {
    expect(() => new GitLabAdapter('')).toThrow(/reconnect it in project settings/i);
  });
});
