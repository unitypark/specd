import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  connections,
  createDb,
  projects,
  repositories,
  tickets,
  users,
  webhookDeliveries,
  type DbHandle,
} from '@specd/db';
import type { SpecContent } from '@specd/shared';
import { SpecsService } from '../specs/specs.service.js';
import { GitHubWebhookService } from './github-webhook.service.js';
import type { GitHubAppService } from './github-app.service.js';
import type { PipelineService } from '../agents/pipeline.service.js';
import type { RepositoriesService } from '../projects/repositories.service.js';

/**
 * The merge → delivered → re-index chain, against a real Postgres.
 *
 * This replaces a button someone had to remember to press ("I merged it").
 * The claims worth testing are therefore about *state*: a merged PR moves the
 * spec and triggers exactly one index; a redelivery of the same event moves
 * nothing and triggers none.
 *
 * The pipeline is a recording stub — indexing is tested elsewhere, and what
 * matters here is that it was asked exactly once, for the right repository.
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://specd:specd@localhost:5433/specd';

let handle: DbHandle | null = null;
let service: GitHubWebhookService;
let specs: SpecsService;
let projectId = '';
let repoId = '';
let ticketId = '';
let userId = '';
let specId = '';

const reindexCalls: { projectId: string; repositoryIds?: string[]; triggeredByName?: string }[] = [];
const forgotten: string[] = [];

const INSTALLATION_ID = '55501';
const REPO_FULL_NAME = 'acme/webhook-test';

const content: SpecContent = {
  requirements: [
    {
      story: 'As a user I want CSV export',
      criteria: [{ keyword: 'WHEN', trigger: 'I click export', response: 'produce a CSV' }],
    },
  ],
  design: [{ text: 'reuse the exporter', citation: 'knowledge/architecture.md#export' }],
  tasks: [
    { id: 'T1', title: 'build it', size: 'M' },
    { id: 'T2', title: 'commit as-built spec', size: 'S', asBuilt: true },
  ],
};

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

/** A merged-PR delivery, shaped the way GitHub sends it. */
function mergedPr(branch: string, overrides: Record<string, unknown> = {}) {
  return {
    action: 'closed',
    pull_request: {
      number: 7,
      merged: true,
      head: { ref: branch },
      base: { ref: 'main' },
      merged_by: { login: 'alice' },
    },
    repository: { full_name: REPO_FULL_NAME, default_branch: 'main' },
    installation: { id: Number(INSTALLATION_ID) },
    ...overrides,
  } as Record<string, unknown>;
}

describe.skipIf(!reachable)('github webhooks (integration)', () => {
  beforeAll(async () => {
    handle = createDb(DATABASE_URL, { max: 2 });
    specs = new SpecsService(handle.db);

    const stamp = Date.now();
    const [user] = await handle.db
      .insert(users)
      .values({ email: `hook-${stamp}@specd.dev`, name: 'Hook Tester', passwordHash: 'x' })
      .returning();
    userId = user!.id;

    const [project] = await handle.db
      .insert(projects)
      .values({ slug: `hook-${stamp}`, name: 'Hook Test' })
      .returning();
    projectId = project!.id;

    // The installation id on the connection is what lets a webhook find its
    // project — without it the delivery is unattributable and dropped.
    await handle.db.insert(connections).values({
      projectId,
      kind: 'vcs',
      provider: 'github',
      settings: { installationId: INSTALLATION_ID },
    });

    const [repo] = await handle.db
      .insert(repositories)
      .values({
        projectId,
        provider: 'github',
        name: REPO_FULL_NAME,
        defaultBranch: 'main',
        isPrimary: true,
        setupBranch: 'specd/setup',
        setupState: 'open',
      })
      .returning();
    repoId = repo!.id;

    const [ticket] = await handle.db
      .insert(tickets)
      .values({ projectId, key: 'HOOK-1', title: 'Export contacts to CSV' })
      .returning();
    ticketId = ticket!.id;

    const spec = await specs.createVersion({ projectId, ticketId, content });
    specId = spec.id;
    await specs.transition({
      projectId,
      specId,
      to: 'in_review',
      actor: { userId, name: 'Hook Tester' },
    });
    await specs.transition({
      projectId,
      specId,
      to: 'approved',
      actor: { userId, name: 'Hook Tester' },
    });
    await specs.transition({ projectId, specId, to: 'building', actor: null });

    const repositoriesService = {
      get: async (_p: string, id: string) => {
        const [row] = await handle!.db.select().from(repositories).where(eq(repositories.id, id));
        return row!;
      },
      markSetupMerged: async (p: string, id: string) => {
        const [row] = await handle!.db
          .update(repositories)
          .set({ setupState: 'merged' })
          .where(eq(repositories.id, id))
          .returning();
        return row!;
      },
    } as unknown as RepositoriesService;

    const pipeline = {
      enqueueReindex: async (input: {
        projectId: string;
        repositoryIds?: string[];
        triggeredByName?: string;
      }) => {
        reindexCalls.push(input);
        return { runId: 'stub', status: 'queued' as const };
      },
    } as unknown as PipelineService;

    const app = {
      forget: (id: string) => forgotten.push(id),
    } as unknown as GitHubAppService;

    service = new GitHubWebhookService(handle.db, repositoriesService, specs, pipeline, app);
  });

  afterAll(async () => {
    if (handle) {
      await handle.db.delete(webhookDeliveries).where(eq(webhookDeliveries.projectId, projectId));
      if (projectId) await handle.db.delete(projects).where(eq(projects.id, projectId));
      if (userId) await handle.db.delete(users).where(eq(users.id, userId));
      await handle.close();
    }
  });

  it('records every delivery it accepts', async () => {
    const deliveryId = randomUUID();
    await service.handle({ deliveryId, event: 'ping', payload: { zen: 'Keep it logically awesome' } });

    const [row] = await handle!.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, deliveryId));

    expect(row?.event).toBe('ping');
    expect(row?.outcome).toBe('ignored');
  });

  it('marks setup merged and re-indexes when the setup PR lands', async () => {
    const before = reindexCalls.length;
    const result = await service.handle({
      deliveryId: randomUUID(),
      event: 'pull_request',
      payload: mergedPr('specd/setup'),
    });

    expect(result.outcome).toBe('setup-merged');

    const [repo] = await handle!.db.select().from(repositories).where(eq(repositories.id, repoId));
    expect(repo?.setupState).toBe('merged');
    expect(reindexCalls.length).toBe(before + 1);
    expect(reindexCalls.at(-1)).toMatchObject({ projectId, repositoryIds: [repoId] });
  });

  it('credits the webhook, not a person, in the run it triggers', async () => {
    // A merge has no signed-in specd user behind it. Attributing the index run
    // to one would put a false name in the audit trail (§10).
    expect(reindexCalls.at(-1)?.triggeredByName).toBe('github webhook (merged by alice)');
  });

  it('ignores a redelivery of an event it already handled', async () => {
    // GitHub retries, and the Advanced tab has a Redeliver button. Neither may
    // re-run an index or re-log a merge.
    const deliveryId = randomUUID();
    const payload = mergedPr('spec/hook-1-export-contacts-to-csv');

    const first = await service.handle({ deliveryId, event: 'pull_request', payload });
    const callsAfterFirst = reindexCalls.length;
    const second = await service.handle({ deliveryId, event: 'pull_request', payload });

    expect(first.outcome).toBe('spec-merged');
    expect(second.outcome).toBe('duplicate');
    expect(reindexCalls.length).toBe(callsAfterFirst);
  });

  it('moved the spec to delivered when its branch merged', async () => {
    const spec = await specs.byId(projectId, specId);
    expect(spec.status).toBe('delivered');
  });

  it('does not re-deliver an already delivered spec on a fresh delivery id', async () => {
    // Same merge, new delivery id (a replay from a different source). The spec
    // is already delivered, and `delivered` has no outgoing transitions — this
    // must be a no-op rather than a 400 bubbling out to GitHub.
    const result = await service.handle({
      deliveryId: randomUUID(),
      event: 'pull_request',
      payload: mergedPr('spec/hook-1-export-contacts-to-csv'),
    });
    expect(result.outcome).toBe('spec-merged');
    expect((await specs.byId(projectId, specId)).status).toBe('delivered');
  });

  it('ignores a PR closed without merging', async () => {
    const payload = mergedPr('spec/hook-1-export-contacts-to-csv');
    (payload.pull_request as { merged: boolean }).merged = false;

    const before = reindexCalls.length;
    const result = await service.handle({
      deliveryId: randomUUID(),
      event: 'pull_request',
      payload,
    });

    expect(result.outcome).toBe('ignored');
    expect(reindexCalls.length).toBe(before);
  });

  it('drops an event for a repository no project has registered', async () => {
    const result = await service.handle({
      deliveryId: randomUUID(),
      event: 'pull_request',
      payload: mergedPr('specd/setup', {
        repository: { full_name: 'someone-else/private-repo', default_branch: 'main' },
      }),
    });
    expect(result.outcome).toBe('unmatched');
  });

  it('drops an event whose installation does not match the connection', async () => {
    // Same repo name, different installation. Acting on it would let one
    // customer's installation drive another customer's project.
    const result = await service.handle({
      deliveryId: randomUUID(),
      event: 'pull_request',
      payload: mergedPr('specd/setup', { installation: { id: 99999 } }),
    });
    expect(result.outcome).toBe('unmatched');
  });

  it('re-indexes a push that changes knowledge/ on the default branch', async () => {
    const before = reindexCalls.length;
    const result = await service.handle({
      deliveryId: randomUUID(),
      event: 'push',
      payload: {
        ref: 'refs/heads/main',
        commits: [{ modified: ['knowledge/architecture.md'] }],
        repository: { full_name: REPO_FULL_NAME, default_branch: 'main' },
        installation: { id: Number(INSTALLATION_ID) },
      },
    });

    expect(result.outcome).toBe('reindex');
    expect(reindexCalls.length).toBe(before + 1);
  });

  it('ignores a push that touches only application code', async () => {
    const before = reindexCalls.length;
    const result = await service.handle({
      deliveryId: randomUUID(),
      event: 'push',
      payload: {
        ref: 'refs/heads/main',
        commits: [{ modified: ['src/index.ts'] }],
        repository: { full_name: REPO_FULL_NAME, default_branch: 'main' },
        installation: { id: Number(INSTALLATION_ID) },
      },
    });

    expect(result.outcome).toBe('ignored');
    expect(reindexCalls.length).toBe(before);
  });

  it('revokes the connection and drops the cached token when the App is uninstalled', async () => {
    const result = await service.handle({
      deliveryId: randomUUID(),
      event: 'installation',
      payload: { action: 'deleted', installation: { id: Number(INSTALLATION_ID) } },
    });

    expect(result.outcome).toBe('installation-revoked');
    expect(forgotten).toContain(INSTALLATION_ID);

    const [conn] = await handle!.db
      .select()
      .from(connections)
      .where(eq(connections.projectId, projectId));
    expect(conn?.status).toBe('revoked');
  });

  it('ignores a delivery id that is not a uuid instead of erroring', async () => {
    // The id is the deduplication key and the column is a uuid. A malformed one
    // would throw on insert, surface as a 500, and have GitHub retry it forever.
    const result = await service.handle({
      deliveryId: 'not-a-uuid',
      event: 'ping',
      payload: {},
    });
    expect(result.outcome).toBe('ignored');
    expect(result.detail).toContain('uuid');
  });

  it('records a handler failure on the delivery instead of throwing at GitHub', async () => {
    // GitHub disables an endpoint that keeps 500ing. A broken handler must
    // leave a diagnosable row, not a dead webhook.
    const broken = new GitHubWebhookService(
      handle!.db,
      {
        get: async () => {
          throw new Error('database on fire');
        },
        markSetupMerged: async () => {
          throw new Error('database on fire');
        },
      } as unknown as RepositoriesService,
      specs,
      {
        enqueueReindex: async () => {
          throw new Error('database on fire');
        },
      } as unknown as PipelineService,
      { forget: () => undefined } as unknown as GitHubAppService,
    );

    const deliveryId = randomUUID();
    const result = await broken.handle({
      deliveryId,
      event: 'push',
      payload: {
        ref: 'refs/heads/main',
        commits: [{ modified: ['knowledge/a.md'] }],
        repository: { full_name: REPO_FULL_NAME, default_branch: 'main' },
        installation: { id: Number(INSTALLATION_ID) },
      },
    });

    expect(result.outcome).toBe('error');
    expect(result.detail).toContain('database on fire');

    const [row] = await handle!.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, deliveryId));
    expect(row?.outcome).toBe('error');
  });
});
