import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitLabAdapter } from './gitlab.adapter.js';
import { VcsError } from './vcs.types.js';

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

  it('accepts the host people actually type for a self-managed instance', () => {
    // `gitlab.example.com` is not a URL — WHATWG reads the host as a scheme —
    // and `fetch` answers an unparseable URL with a TypeError, which used to
    // reach the wizard as "Internal server error".
    expect(new GitLabAdapter('tok', 'gitlab.example.com').instanceUrl).toBe(
      'https://gitlab.example.com',
    );
    expect(new GitLabAdapter('tok', 'https://gitlab.example.com/').instanceUrl).toBe(
      'https://gitlab.example.com',
    );
    // http stays http — a self-managed instance may genuinely be served on it.
    expect(new GitLabAdapter('tok', 'http://gitlab.internal:8080').instanceUrl).toBe(
      'http://gitlab.internal:8080',
    );
  });

  it('keeps a subpath, because GitLab can be served from one', () => {
    // `external_url 'https://host/gitlab'` is a supported deployment, and its
    // API really is at {origin}/gitlab/api/v4. Reducing the URL to its origin
    // to be helpful to someone pasting a project URL would break every one of
    // these — a deployment somebody chose, traded for a typo somebody made.
    expect(new GitLabAdapter('tok', 'https://intranet.example.com/gitlab/').instanceUrl).toBe(
      'https://intranet.example.com/gitlab',
    );
  });

  it('names what is wrong with a URL it cannot use', () => {
    expect(() => new GitLabAdapter('tok', 'ftp://gitlab.example.com')).toThrow(
      /speaks only http and https/i,
    );
    expect(() => new GitLabAdapter('tok', 'not a url at all')).toThrow(/is not a URL specd can reach/i);
  });

});

describe('a nested group on a self-managed instance', () => {
  // GitLab mode against the shape a real corporate instance has: a host that
  // is not gitlab.com, and a project two groups deep. Both are places a URL
  // can be built wrong without any test noticing.
  const INSTANCE = 'https://gitlab.example.com';
  const PROJECT = 'acme/services/aurora-api';
  const ENCODED = 'acme%2Fservices%2Faurora-api';

  it('addresses the instance and the full namespace path, encoded as GitLab wants it', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        seen.push(url);
        const body = JSON.stringify({ web_url: `${INSTANCE}/${PROJECT}/-/merge_requests/3`, iid: 3 });
        return { ok: true, status: 201, text: async () => body, json: async () => JSON.parse(body) };
      }),
    );

    const opened = await new GitLabAdapter('glpat-x', INSTANCE).openMergeRequest(PROJECT, {
      branch: 'spec/E-101-add-csv-export',
      base: 'main',
      title: '[E-101] - Add CSV export',
      body: 'body',
    });

    // A nested group is one path with slashes in it, not a namespace plus a
    // project — so it is percent-encoded whole. Splitting it would address
    // `acme/services`, which is a group and not a project.
    expect(seen[0]).toBe(`${INSTANCE}/api/v4/projects/${ENCODED}/merge_requests`);
    expect(opened.url).toBe(`${INSTANCE}/${PROJECT}/-/merge_requests/3`);
  });

  it('proves a token against the instance it was given, not gitlab.com', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        seen.push(url);
        const body = JSON.stringify({ username: 'jpark', name: 'J Park' });
        return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
      }),
    );

    await expect(new GitLabAdapter('glpat-x', INSTANCE).verify()).resolves.toEqual({
      username: 'jpark',
      name: 'J Park',
    });
    expect(seen[0]).toBe(`${INSTANCE}/api/v4/user`);
  });
});

describe('a 200 that is not JSON', () => {
  /**
   * The reported symptom: `Unexpected token '<', "<!DOCTYPE "... is not valid
   * JSON`. An access portal in front of a corporate instance answers an
   * API request with its own login page at 200, so `res.ok` is true and
   * `res.json()` throws a SyntaxError — not an HttpException, so it reached a
   * user as an opaque failure naming a doctype.
   */
  const loginPage =
    '<!DOCTYPE html><html><head><title>Sign in</title></head><body>SSO</body></html>';

  it('names the portal rather than the parser', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, text: async () => loginPage, json: async () => ({}) })),
    );

    await expect(new GitLabAdapter('tok', 'https://gitlab.example.com').verify()).rejects.toThrow(
      /HTML page rather than JSON.*SSO or access portal/is,
    );
  });

  it('is a VcsError, so the controller answers 400 and not 500', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, text: async () => loginPage, json: async () => ({}) })),
    );

    await expect(
      new GitLabAdapter('tok', 'https://gitlab.example.com').listRepositories(),
    ).rejects.toBeInstanceOf(VcsError);
  });

  it('quotes a short non-HTML body instead of guessing at a portal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, text: async () => 'upstream connect error', json: async () => ({}) })),
    );

    await expect(new GitLabAdapter('tok', 'https://gitlab.example.com').verify()).rejects.toThrow(
      /not JSON: "upstream connect error"/,
    );
  });

  it('leaves a 204 alone — no body is not a broken body', async () => {
    // Branch deletion answers 204 with an empty body, and parsing '' fails
    // exactly the way a login page does. `propose` is the public path that
    // deletes a branch, so it is what proves the empty case still passes.
    const bodies: Record<string, { status: number; body: string }> = {
      'GET /projects/acme%2Fapi': { status: 200, body: '{"default_branch":"main"}' },
      'DELETE /projects/acme%2Fapi/repository/branches/specd%2Fsetup': { status: 204, body: '' },
      'POST /projects/acme%2Fapi/repository/commits': { status: 201, body: '{"id":"abc"}' },
      'POST /projects/acme%2Fapi/merge_requests': {
        status: 201,
        body: '{"web_url":"https://gitlab.example.com/acme/api/-/merge_requests/1","iid":1}',
      },
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        const key = `${init.method ?? 'GET'} ${url.replace('https://gitlab.example.com/api/v4', '')}`;
        const hit = bodies[key];
        if (!hit) throw new Error(`unstubbed: ${key}`);
        return { ok: true, status: hit.status, text: async () => hit.body, json: async () => JSON.parse(hit.body || '{}') };
      }),
    );

    const change = await new GitLabAdapter('tok', 'https://gitlab.example.com').propose(
      { name: 'acme/api' } as RepoTarget,
      { branch: 'specd/setup', title: 'setup', body: 'body', files: [{ path: 'a.md', content: '#\n' }] },
    );

    expect(change.url).toBe('https://gitlab.example.com/acme/api/-/merge_requests/1');
  });
});

describe('an instance URL that carries a project path', () => {
  // The shape people paste out of the address bar: a nested-group project on
  // a self-managed instance. The host is right, the path is not GitLab's root,
  // and `{that}/api/v4` is a 404 nobody can work backwards from unaided.
  const PASTED = 'https://gitlab.example.com/acme/services/aurora-api';

  it('is kept verbatim, and the 404 explains which half is wrong', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => '404 Not Found',
        json: async () => ({}),
      })),
    );

    const adapter = new GitLabAdapter('tok', PASTED);
    expect(adapter.instanceUrl).toBe(PASTED);

    await expect(adapter.listRepositories()).rejects.toThrow(
      /includes the path "\/acme\/services\/aurora-api".*https:\/\/gitlab\.example\.com/is,
    );
  });

  it('stops second-guessing the URL once the instance has answered once', async () => {
    // A 404 after a successful call is a missing project, not a wrong host,
    // and telling someone to fix their instance URL then would be wrong.
    const responses = [
      { ok: true, status: 200, json: async () => [], text: async () => '[]' },
      { ok: false, status: 404, statusText: 'Not Found', text: async () => '404', json: async () => ({}) },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => responses.shift()));

    const adapter = new GitLabAdapter('tok', 'https://gitlab.example.com');
    await adapter.listRepositories();

    await expect(adapter.listRepositories()).rejects.toThrow(/→ 404/);
  });
});

describe('a request that never reaches the instance', () => {
  /**
   * The reported bug. Everything about a self-managed GitLab that can go wrong
   * — VPN off, internal DNS, an untrusted internal CA — fails this way, and
   * `fetch` reports all of it as `TypeError: fetch failed` with the reason on
   * `cause.code`. A TypeError is not an HttpException, so Nest rendered every
   * one of them as "Internal server error".
   */
  const transportError = (code: string) => {
    const err = new TypeError('fetch failed');
    (err as { cause?: unknown }).cause = { code };
    return err;
  };

  it('explains an unresolvable host instead of failing opaquely', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw transportError('ENOTFOUND');
      }),
    );

    await expect(
      new GitLabAdapter('tok', 'gitlab.internal').listRepositories(),
    ).rejects.toThrow(/does not resolve.*VPN/is);
  });

  it('points an untrusted certificate at the CA store rather than at the token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw transportError('DEPTH_ZERO_SELF_SIGNED_CERT');
      }),
    );

    await expect(new GitLabAdapter('tok', 'gitlab.internal').listRepositories()).rejects.toThrow(
      /self-signed certificate.*NODE_EXTRA_CA_CERTS/is,
    );
  });

  it('is a VcsError, which is what the controller turns into a 400', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw transportError('ECONNREFUSED');
      }),
    );

    await expect(
      new GitLabAdapter('tok', 'gitlab.internal').listRepositories(),
    ).rejects.toBeInstanceOf(VcsError);
  });
});
