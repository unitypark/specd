import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubAdapter } from './github.adapter.js';
import type { RepoTarget } from './vcs.types.js';

/**
 * Against a stubbed transport, not a live host.
 *
 * What this can prove: `propose` builds its branch and commit through the git
 * data API, and — the reason this file exists — that a second run against a
 * repository whose setup PR is still open updates that PR instead of dying on
 * GitHub's 422. What it cannot prove is that GitHub accepts the requests; only
 * a real token does that, the first time one is connected.
 */

const SLUG = 'acme/aurora-api';

const repo: RepoTarget = {
  id: 'repo-1',
  name: SLUG,
  provider: 'github',
  localPath: null,
  externalId: '42',
  defaultBranch: 'main',
};

const change = {
  branch: 'specd/setup',
  title: 'specd: working agreements and knowledge scaffold',
  body: 'Merging is adopting.\n\nSecond line.',
  files: [{ path: 'AGENTS.md', content: '# agreements' }],
};

/**
 * Routes by `METHOD /path` rather than by call order: `propose` makes eight
 * requests and a sequence-keyed stub would say nothing about which one broke.
 * A route returning `null` stands for a non-2xx, which is what the adapter
 * turns into a throw. An unrouted request is the test's mistake rather than the
 * adapter's, so it throws by name: answering it with an empty 200 would let a
 * mistyped route key read as a working adapter.
 */
function stub(routes: Record<string, unknown | null>) {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = url.replace('https://api.github.com', '');
    const key = `${init.method ?? 'GET'} ${path}`;
    calls.push(key);

    if (!Object.hasOwn(routes, key)) throw new Error(`unstubbed request: ${key}`);

    const body = routes[key];
    const ok = body !== null;

    return {
      ok,
      status: ok ? 200 : 422,
      statusText: 'stubbed',
      json: async () => body ?? {},
      text: async () => JSON.stringify(body ?? { message: 'Validation Failed' }),
    };
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

/** Everything `propose` needs up to the pull request itself. */
const upToThePr = {
  [`GET /repos/${SLUG}`]: { default_branch: 'main' },
  [`GET /repos/${SLUG}/git/ref/heads/main`]: { object: { sha: 'base-sha' } },
  [`POST /repos/${SLUG}/git/refs`]: { ref: 'refs/heads/specd/setup' },
  [`POST /repos/${SLUG}/git/blobs`]: { sha: 'blob-sha' },
  [`POST /repos/${SLUG}/git/trees`]: { sha: 'tree-sha' },
  [`POST /repos/${SLUG}/git/commits`]: { sha: 'commit-sha' },
  [`PATCH /repos/${SLUG}/git/refs/heads/specd/setup`]: { ref: 'refs/heads/specd/setup' },
};

const adapter = () => new GitHubAdapter('tok-123');

afterEach(() => vi.unstubAllGlobals());

describe('propose', () => {
  it('opens a pull request on a repository that has none', async () => {
    const calls = stub({
      ...upToThePr,
      [`POST /repos/${SLUG}/pulls`]: { html_url: 'https://github.com/acme/aurora-api/pull/7', number: 7 },
    });

    const result = await adapter().propose(repo, change);

    expect(result).toMatchObject({
      branch: 'specd/setup',
      url: 'https://github.com/acme/aurora-api/pull/7',
      filesWritten: 1,
    });
    expect(result.reviewHint).toBe(`Opened PR #7 on ${SLUG}. Merging is adopting.`);
    // The commit is built through the git data API, not pushed.
    expect(calls).toContain(`POST /repos/${SLUG}/git/blobs`);
    expect(calls).toContain(`POST /repos/${SLUG}/git/commits`);
  });

  it('updates the open pull request instead of failing on a re-run', async () => {
    // GitHub answers 422 to a second PR for the same head. Before this was
    // handled, re-grounding a repository failed here — with the scaffold
    // already written and the branch already force-reset to the new commit.
    const calls = stub({
      ...upToThePr,
      [`POST /repos/${SLUG}/pulls`]: null,
      [`GET /repos/${SLUG}/pulls?head=acme%3Aspecd%2Fsetup&state=open`]: [
        { html_url: 'https://github.com/acme/aurora-api/pull/3', number: 3 },
      ],
    });

    const result = await adapter().propose(repo, change);

    expect(result.url).toBe('https://github.com/acme/aurora-api/pull/3');
    // Says which of the two things happened rather than claiming both are
    // "Opened" — the wizard prints this line verbatim.
    expect(result.reviewHint).toBe(`Updated PR #3 on ${SLUG}. Merging is adopting.`);
    expect(calls).toContain(`GET /repos/${SLUG}/pulls?head=acme%3Aspecd%2Fsetup&state=open`);
  });

  it('resets an existing branch rather than giving up on it', async () => {
    const calls = stub({
      ...upToThePr,
      // A branch left by an earlier run: creating the ref is refused.
      [`POST /repos/${SLUG}/git/refs`]: null,
      [`POST /repos/${SLUG}/pulls`]: { html_url: 'https://github.com/acme/aurora-api/pull/7', number: 7 },
    });

    await expect(adapter().propose(repo, change)).resolves.toMatchObject({ filesWritten: 1 });
    // Once to reset onto the base tip, once to point at the new commit.
    expect(calls.filter((c) => c === `PATCH /repos/${SLUG}/git/refs/heads/specd/setup`)).toHaveLength(2);
  });

  it('still fails when the pull request is refused for some other reason', async () => {
    // No open PR for the head means the 422 was not "one already exists", and
    // swallowing it would report a review surface that does not exist.
    stub({
      ...upToThePr,
      [`POST /repos/${SLUG}/pulls`]: null,
      [`GET /repos/${SLUG}/pulls?head=acme%3Aspecd%2Fsetup&state=open`]: [],
    });

    await expect(adapter().propose(repo, change)).rejects.toThrow(/pulls/);
  });
});

describe('construction', () => {
  it('refuses to exist without a token, naming the fix', () => {
    expect(() => new GitHubAdapter('')).toThrow(/reconnect the github app/i);
  });
});
