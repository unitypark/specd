import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, projects, tickets, type DbHandle } from '@specd/db';
import { TrackerService, describeTransition } from './tracker.service.js';
import { ConnectionsService } from '../projects/connections.service.js';
import { Vault } from '../common/vault.js';
import { Config } from '../config.js';

/**
 * The rule under test is decision 0010's first one: **a Jira failure can never
 * fail a specd action.** The spec lifecycle and the human gate are specd's own
 * guarantees, so an Atlassian outage must not be able to stop a team approving
 * their own work — every one of these asserts an outcome is *returned* rather
 * than thrown.
 *
 * Real Postgres for the ticket/connection lookups, stubbed transport for Jira.
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://specd:specd@localhost:5433/specd';

let handle: DbHandle | null = null;
let tracker: TrackerService;
let projectId = '';
let jiraTicketId = '';
let nativeTicketId = '';

const reachable = await (async () => {
  try {
    const probe = createDb(DATABASE_URL, { max: 1 });
    await probe.sql`SELECT 1`;
    await probe.close();
    return true;
  } catch {
    return false;
  }
})();

/** Every fetch fails, the way an outage or a revoked token would. */
function jiraIsDown(message = 'connect ETIMEDOUT') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error(message);
    }),
  );
}

function jiraReturns(responses: { status?: number; body?: unknown }[]) {
  let i = 0;
  const fn = vi.fn(async () => {
    const r = responses[Math.min(i++, responses.length - 1)] ?? { body: {} };
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'stubbed',
      json: async () => r.body ?? {},
      text: async () => JSON.stringify(r.body ?? {}),
    };
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe.skipIf(!reachable)('TrackerService (integration)', () => {
  beforeAll(async () => {
    handle = createDb(DATABASE_URL, { max: 2 });
    // Config reads the environment at construction; set only what this needs,
    // same convention as vault.test.ts.
    process.env.DATABASE_URL ??= DATABASE_URL;
    process.env.JWT_SECRET ??= 'test';
    process.env.VAULT_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
    const config = new Config();
    const vault = new Vault(config);
    const connections = new ConnectionsService(handle.db, vault, config);
    tracker = new TrackerService(handle.db, connections, vault, config);

    const [project] = await handle.db
      .insert(projects)
      .values({ slug: `tracker-test-${Date.now()}`, name: 'Tracker Test' })
      .returning();
    projectId = project!.id;

    const [jiraTicket] = await handle.db
      .insert(tickets)
      .values({
        projectId,
        key: 'AUR-142',
        title: 'Export contacts',
        source: 'jira',
        externalKey: 'AUR-142',
        externalUrl: 'https://acme.atlassian.net/browse/AUR-142',
      })
      .returning();
    jiraTicketId = jiraTicket!.id;

    const [nativeTicket] = await handle.db
      .insert(tickets)
      .values({ projectId, key: 'TT-1', title: 'Written here', source: 'native' })
      .returning();
    nativeTicketId = nativeTicket!.id;

    await connections.upsert({
      projectId,
      kind: 'tracker',
      provider: 'jira',
      label: 'Jira AUR',
      settings: {
        projectKey: 'AUR',
        siteUrl: 'https://acme.atlassian.net',
        email: 'theo@acme.test',
        statusMap: { approved: 'In Progress', delivered: 'Done' },
      },
      secret: 'jira-api-token',
    });
  });

  afterAll(async () => {
    if (handle) {
      await handle.db.delete(projects).where(eq(projects.id, projectId));
      await handle.close();
    }
  });

  afterEach(() => vi.unstubAllGlobals());

  it('reports an outage instead of throwing it', async () => {
    jiraIsDown();

    const outcome = await tracker.mirrorStatus({ projectId, issueKey: 'AUR-142', to: 'approved' });

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toMatch(/failed/i);
    expect(outcome.detail).toMatch(/ETIMEDOUT/);
  });

  it('never throws out of a whole transition mirror, however badly Jira behaves', async () => {
    jiraIsDown('socket hang up');

    // This is the assertion that matters: SpecsService calls this after the
    // spec row is already committed. Anything escaping here could only
    // produce an unhandled rejection, never a rollback — but it must not
    // escape at all.
    await expect(
      tracker.mirrorSpecTransition({
        projectId,
        ticketId: jiraTicketId,
        specId: '00000000-0000-0000-0000-000000000001',
        to: 'approved',
      }),
    ).resolves.toBeInstanceOf(Array);
  });

  it('does nothing at all for a ticket that did not come from Jira', async () => {
    const fetchMock = jiraReturns([{ body: {} }]);

    const outcomes = await tracker.mirrorSpecTransition({
      projectId,
      ticketId: nativeTicketId,
      specId: '00000000-0000-0000-0000-000000000002',
      to: 'approved',
    });

    expect(outcomes).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips silently when the status has no mapping, rather than guessing', async () => {
    const fetchMock = jiraReturns([{ body: {} }]);

    // `in_review` is deliberately absent from this project's statusMap.
    const outcome = await tracker.mirrorStatus({ projectId, issueKey: 'AUR-142', to: 'in_review' });

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toMatch(/no Jira status mapped/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a workflow that offers no route to the mapped status as a no-op', async () => {
    // Jira answers the transitions query, but nothing leads to "In Progress".
    jiraReturns([{ body: { transitions: [{ id: '5', name: 'Close', to: { name: 'Closed' } }] } }]);

    const outcome = await tracker.mirrorStatus({ projectId, issueKey: 'AUR-142', to: 'approved' });

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toMatch(/no transition to "In Progress"/i);
    expect(outcome.detail).toMatch(/left alone/i);
  });

  it('mirrors the mapped status when the workflow allows it', async () => {
    jiraReturns([
      { body: { transitions: [{ id: '11', name: 'Start', to: { name: 'In Progress' } }] } },
      { status: 204 },
    ]);

    const outcome = await tracker.mirrorStatus({ projectId, issueKey: 'AUR-142', to: 'approved' });

    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toBe('AUR-142 → "In Progress"');
  });

  it('comments a backlink that points at this spec in this project', async () => {
    const fetchMock = jiraReturns([{ body: { id: '1' } }, { body: { transitions: [] } }]);

    await tracker.mirrorSpecTransition({
      projectId,
      ticketId: jiraTicketId,
      specId: 'abc-123',
      to: 'approved',
    });

    const commentCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/comment'));
    expect(commentCall).toBeTruthy();
    const body = JSON.parse((commentCall![1] as RequestInit).body as string) as {
      body: { content: { content: { text: string }[] }[] };
    };
    const text = body.body.content.flatMap((p) => p.content ?? []).map((t) => t.text).join('\n');
    expect(text).toMatch(/approved by a person/i);
    expect(text).toContain('?spec=abc-123');
  });

  it('returns no adapter for a project with no Jira connection', async () => {
    expect(await tracker.jiraFor('00000000-0000-0000-0000-000000000009')).toBeNull();
  });
});

describe('describeTransition', () => {
  it('says a person approved it, because that distinction is the product', () => {
    const text = describeTransition('approved', 'https://specd.test/p/x?spec=1');
    expect(text).toMatch(/approved by a person/i);
    expect(text).toContain('https://specd.test/p/x?spec=1');
  });

  it('has something to say for every lifecycle state, and a fallback besides', () => {
    for (const status of ['draft', 'in_review', 'changes_requested', 'approved', 'building', 'delivered', 'blocked'] as const) {
      expect(describeTransition(status, 'https://x.test')).not.toMatch(/moved to "/);
    }
    // An unknown state still produces a sentence rather than "undefined".
    expect(describeTransition('invented' as never, 'https://x.test')).toMatch(/moved to "invented"/);
  });
});
