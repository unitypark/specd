import { afterEach, describe, expect, it, vi } from 'vitest';
import { JiraAdapter, JiraError, adf, plainText } from './jira.adapter.js';

/**
 * Against a stubbed transport, not a live site.
 *
 * What this can prove: the requests are shaped the way Jira Cloud's v3 REST
 * contract documents, the auth header is right, comment bodies are ADF rather
 * than strings, and failures become messages a person can act on. What it
 * cannot prove is that Atlassian accepts them — decision 0010 says so plainly,
 * and the connect flow calls /myself so a real credential proves the transport
 * end-to-end the first time one is pasted.
 */

const SITE = 'https://acme.atlassian.net';

function stub(responses: { status?: number; body?: unknown }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  let i = 0;
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const r = responses[Math.min(i++, responses.length - 1)] ?? { body: {} };
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'stubbed',
      json: async () => r.body ?? {},
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {})),
    };
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

const jira = () => new JiraAdapter(SITE, 'theo@acme.test', 'tok-123');

afterEach(() => vi.unstubAllGlobals());

describe('construction', () => {
  it('refuses to exist without a credential, naming the fix', () => {
    expect(() => new JiraAdapter(SITE, 'theo@acme.test', '')).toThrow(/reconnect it/i);
    expect(() => new JiraAdapter('', 'theo@acme.test', 'tok')).toThrow(/site url/i);
  });

  it('tolerates a trailing slash on the site URL', () => {
    const a = new JiraAdapter(`${SITE}/`, 'theo@acme.test', 'tok');
    expect(a.browseUrl('AUR-1')).toBe(`${SITE}/browse/AUR-1`);
  });
});

describe('auth and request shape', () => {
  it('sends HTTP Basic of email:token against the v3 API', async () => {
    const calls = stub([{ body: { accountId: 'a1', displayName: 'Theo', emailAddress: 'theo@acme.test' } }]);

    const me = await jira().verify();

    expect(me).toEqual({ accountId: 'a1', displayName: 'Theo', email: 'theo@acme.test' });
    expect(calls[0]!.url).toBe(`${SITE}/rest/api/3/myself`);
    const auth = (calls[0]!.init.headers as Record<string, string>).Authorization;
    expect(auth).toBe(`Basic ${Buffer.from('theo@acme.test:tok-123').toString('base64')}`);
  });

  it('omits Content-Type on reads and sets it on writes', async () => {
    const calls = stub([{ body: { values: [] } }, { body: { id: '1' } }]);

    await jira().listProjects();
    await jira().addComment('AUR-1', 'hello');

    expect((calls[0]!.init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    expect((calls[1]!.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });
});

describe('listOpenIssues', () => {
  it('asks only for open issues, newest first, and only the fields it uses', async () => {
    const calls = stub([{ body: { issues: [] } }]);
    await jira().listOpenIssues('AUR');

    const url = decodeURIComponent(calls[0]!.url);
    // Importing a closed backlog would fill the board with work nobody will spec.
    expect(url).toContain('statusCategory != Done');
    expect(url).toContain('project = "AUR"');
    expect(url).toContain('ORDER BY created DESC');
    expect(url).toContain('fields=summary,description,status');
  });

  it('caps the page size at Jira’s maximum however much is asked for', async () => {
    const calls = stub([{ body: { issues: [] } }]);
    await jira().listOpenIssues('AUR', 5_000);
    expect(calls[0]!.url).toContain('maxResults=100');
  });

  it('flattens ADF descriptions into text a spec prompt can read', async () => {
    stub([
      {
        body: {
          issues: [
            {
              key: 'AUR-142',
              fields: {
                summary: 'Export contacts to CSV',
                status: { name: 'To Do' },
                description: {
                  type: 'doc',
                  content: [
                    { type: 'paragraph', content: [{ type: 'text', text: 'Sales need a CSV.' }] },
                    { type: 'paragraph', content: [{ type: 'text', text: 'Include tags.' }] },
                  ],
                },
              },
            },
          ],
        },
      },
    ]);

    const [issue] = await jira().listOpenIssues('AUR');
    expect(issue).toEqual({
      key: 'AUR-142',
      summary: 'Export contacts to CSV',
      description: 'Sales need a CSV.\nInclude tags.',
      status: 'To Do',
      url: `${SITE}/browse/AUR-142`,
    });
  });

  it('survives an issue with no description or status at all', async () => {
    stub([{ body: { issues: [{ key: 'AUR-9', fields: { summary: 'bare' } }] } }]);
    const [issue] = await jira().listOpenIssues('AUR');
    expect(issue).toMatchObject({ key: 'AUR-9', description: '', status: '' });
  });
});

describe('addComment', () => {
  it('sends an ADF document, not a string — v3 rejects a plain body', async () => {
    const calls = stub([{ body: { id: '10001' } }]);
    await jira().addComment('AUR-142', 'line one\nline two');

    const body = JSON.parse(calls[0]!.init.body as string) as { body: { type: string; content: unknown[] } };
    expect(typeof body.body).toBe('object');
    expect(body.body.type).toBe('doc');
    expect(body.body.content).toHaveLength(2);
    expect(calls[0]!.url).toBe(`${SITE}/rest/api/3/issue/AUR-142/comment`);
  });
});

describe('transitionTo', () => {
  const transitions = {
    transitions: [
      { id: '11', name: 'Start progress', to: { name: 'In Progress' } },
      { id: '31', name: 'Done', to: { name: 'Done' } },
    ],
  };

  it('resolves the target by destination status name, case-insensitively', async () => {
    const calls = stub([{ body: transitions }, { status: 204 }]);

    expect(await jira().transitionTo('AUR-142', 'in progress')).toBe(true);

    // Matched "In Progress" by where it lands, not by the transition's label.
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({ transition: { id: '11' } });
  });

  it('falls back to matching the transition’s own name', async () => {
    const calls = stub([{ body: transitions }, { status: 204 }]);
    expect(await jira().transitionTo('AUR-142', 'Start progress')).toBe(true);
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({ transition: { id: '11' } });
  });

  it('returns false without posting when the workflow offers no such move', async () => {
    // A normal outcome, not an error: Jira workflows have guards, and a spec
    // reaching `approved` does not oblige the issue to be movable.
    const calls = stub([{ body: transitions }]);
    expect(await jira().transitionTo('AUR-142', 'Released')).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('treats an issue with no available transitions as "cannot move"', async () => {
    stub([{ body: {} }]);
    expect(await jira().transitionTo('AUR-142', 'Done')).toBe(false);
  });
});

describe('errors', () => {
  it('unwraps Jira’s errorMessages into something actionable', async () => {
    stub([{ status: 400, body: { errorMessages: ['Issue does not exist'], errors: {} } }]);
    await expect(jira().getIssue('AUR-999')).rejects.toThrow(/Issue does not exist/);
  });

  it('unwraps field-level errors too', async () => {
    stub([{ status: 400, body: { errorMessages: [], errors: { project: 'project is required' } } }]);
    await expect(jira().listOpenIssues('AUR')).rejects.toThrow(/project is required/);
  });

  it('carries the status code, so a 401 can be told from a 404', async () => {
    stub([{ status: 401, body: { message: 'Unauthorized' } }]);
    const err = await jira().verify().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JiraError);
    expect((err as JiraError).status).toBe(401);
  });

  it('falls back to the raw body when the error is not JSON', async () => {
    stub([{ status: 502, body: '<html>Bad Gateway</html>' }]);
    await expect(jira().verify()).rejects.toThrow(/Bad Gateway/);
  });

  it('explains a bare status code, since Jira often sends no body at all', async () => {
    // A mistyped site URL 404s with an empty body. "→ 404:" tells the person
    // who typed it nothing; naming which of the three fields is likely wrong
    // does.
    stub([{ status: 404, body: '' }]);
    await expect(jira().verify()).rejects.toThrow(/check the site URL/i);

    stub([{ status: 401, body: '' }]);
    await expect(jira().verify()).rejects.toThrow(/email or API token was rejected/i);

    stub([{ status: 500, body: '' }]);
    await expect(jira().verify()).rejects.toThrow(/trouble on its side/i);
  });
});

describe('adf / plainText', () => {
  it('round-trips text through ADF without losing lines', () => {
    expect(plainText(adf('one\ntwo'))).toBe('one\ntwo');
  });

  it('represents a blank line as an empty paragraph, which ADF requires', () => {
    // An empty text node is invalid ADF; the paragraph must simply have no
    // content instead.
    const doc = adf('a\n\nb') as { content: { content: unknown[] }[] };
    expect(doc.content[1]!.content).toEqual([]);
  });

  it('passes an old-style plain-string description straight through', () => {
    expect(plainText('legacy description')).toBe('legacy description');
    expect(plainText(null)).toBe('');
    expect(plainText(undefined)).toBe('');
  });
});
