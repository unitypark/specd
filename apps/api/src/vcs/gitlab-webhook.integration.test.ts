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
import { GitLabWebhookService } from './gitlab-webhook.service.js';
import type { PipelineService } from '../agents/pipeline.service.js';
import type { RepositoriesService } from '../projects/repositories.service.js';

/**
 * The merge → delivered → re-index chain against a real Postgres, GitLab's
 * side of it. Mirrors `github-webhook.integration.test.ts` — same claims
 * about state, same pipeline recording stub — adapted for what actually
 * differs: a Merge Request Hook instead of a pull_request event, and
 * project-id/path matching instead of an installation-linked connection.
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://specd:specd@localhost:5433/specd';

let handle: DbHandle | null = null;
let service: GitLabWebhookService;
let specs: SpecsService;
let projectId = '';
let repoId = '';
let ticketId = '';
let userId = '';
let specId = '';

const reindexCalls: { projectId: string; repositoryIds?: string[]; triggeredByName?: string }[] = [];

const GITLAB_PROJECT_ID = 778899;
const REPO_PATH = 'acme/webhook-test';

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

/** A merged-MR delivery, shaped the way GitLab sends it. */
function mergedMr(branch: string, overrides: Record<string, unknown> = {}) {
  return {
    object_kind: 'merge_request',
    object_attributes: {
      iid: 7,
      action: 'merge',
      state: 'merged',
      source_branch: branch,
      target_branch: 'main',
    },
    project: { id: GITLAB_PROJECT_ID, path_with_namespace: REPO_PATH, default_branch: 'main' },
    user: { username: 'alice' },
    ...overrides,
  } as Record<string, unknown>;
}

describe.skipIf(!reachable)('gitlab webhooks (integration)', () => {
  beforeAll(async () => {
    handle = createDb(DATABASE_URL, { max: 2 });
    specs = new SpecsService(handle.db);

    const stamp = Date.now();
    const [user] = await handle.db
      .insert(users)
      .values({ email: `gl-hook-${stamp}@specd.dev`, name: 'Hook Tester', passwordHash: 'x' })
      .returning();
    userId = user!.id;

    const [project] = await handle.db
      .insert(projects)
      .values({ slug: `gl-hook-${stamp}`, name: 'GitLab Hook Test' })
      .returning();
    projectId = project!.id;

    const [repo] = await handle.db
      .insert(repositories)
      .values({
        projectId,
        provider: 'gitlab',
        name: REPO_PATH,
        externalId: String(GITLAB_PROJECT_ID),
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
      reindex: async (input: {
        projectId: string;
        repositoryIds?: string[];
        triggeredByName?: string;
      }) => {
        reindexCalls.push(input);
        return { indexed: 0, skipped: 0, removed: 0, health: 100, runId: 'stub' };
      },
    } as unknown as PipelineService;

    service = new GitLabWebhookService(handle.db, repositoriesService, specs, pipeline);
  });

  afterAll(async () => {
    if (handle) {
      await handle.db.delete(webhookDeliveries).where(eq(webhookDeliveries.projectId, projectId));
      if (projectId) await handle.db.delete(projects).where(eq(projects.id, projectId));
      if (userId) await handle.db.delete(users).where(eq(users.id, userId));
      await handle.close();
    }
  });

  it('records a delivery it has no handler for', async () => {
    const deliveryId = randomUUID();
    const result = await service.handle({ deliveryId, event: 'Issue Hook', payload: {} });

    expect(result.outcome).toBe('ignored');

    const [row] = await handle!.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, deliveryId));
    expect(row?.event).toBe('Issue Hook');
    expect(row?.outcome).toBe('ignored');
  });

  it('marks setup merged and re-indexes when the setup MR lands', async () => {
    const before = reindexCalls.length;
    const result = await service.handle({
      deliveryId: randomUUID(),
      event: 'Merge Request Hook',
      payload: mergedMr('specd/setup'),
    });

    expect(result.outcome).toBe('setup-merged');

    const [repo] = await handle!.db.select().from(repositories).where(eq(repositories.id, repoId));
    expect(repo?.setupState).toBe('merged');
    expect(reindexCalls.length).toBe(before + 1);
    expect(reindexCalls.at(-1)).toMatchObject({ projectId, repositoryIds: [repoId] });
  });

  it('credits the webhook, not a person, in the run it triggers', async () => {
    expect(reindexCalls.at(-1)?.triggeredByName).toBe('gitlab webhook (merged by alice)');
  });

  it('ignores a redelivery of an event it already handled', async () => {
    const deliveryId = randomUUID();
    const payload = mergedMr('spec/hook-1-export-contacts-to-csv');

    const first = await service.handle({ deliveryId, event: 'Merge Request Hook', payload });
    const callsAfterFirst = reindexCalls.length;
    const second = await service.handle({ deliveryId, event: 'Merge Request Hook', payload });

    expect(first.outcome).toBe('spec-merged');
    expect(second.outcome).toBe('duplicate');
    expect(reindexCalls.length).toBe(callsAfterFirst);
  });

  it('moved the spec to delivered when its branch merged', async () => {
    const spec = await specs.byId(projectId, specId);
    expect(spec.status).toBe('delivered');
  });

  it('does not re-deliver an already delivered spec on a fresh delivery id', async () => {
    const result = await service.handle({
      deliveryId: randomUUID(),
      event: 'Merge Request Hook',
      payload: mergedMr('spec/hook-1-export-contacts-to-csv'),
    });
    expect(result.outcome).toBe('spec-merged');
    expect((await specs.byId(projectId, specId)).status).toBe('delivered');
  });

  it('ignores an MR closed without merging', async () => {
    const payload = mergedMr('spec/hook-1-export-contacts-to-csv', {
      object_attributes: {
        iid: 8,
        action: 'close',
        state: 'closed',
        source_branch: 'spec/hook-1-export-contacts-to-csv',
        target_branch: 'main',
      },
    });

    const before = reindexCalls.length;
    const result = await service.handle({ deliveryId: randomUUID(), event: 'Merge Request Hook', payload });

    expect(result.outcome).toBe('ignored');
    expect(reindexCalls.length).toBe(before);
  });

  it('drops an event for a project no repository has registered', async () => {
    const result = await service.handle({
      deliveryId: randomUUID(),
      event: 'Merge Request Hook',
      payload: mergedMr('specd/setup', {
        project: { id: 999999, path_with_namespace: 'someone-else/private-repo', default_branch: 'main' },
      }),
    });
    expect(result.outcome).toBe('unmatched');
  });

  it('does not match on path alone when the project id differs', async () => {
    // Same path, different GitLab project id — the id is what disambiguates
    // self-managed instances and gitlab.com sharing a namespace (§11). A
    // path-only match here would let a same-named project on another
    // instance drive this one's specs.
    const result = await service.handle({
      deliveryId: randomUUID(),
      event: 'Merge Request Hook',
      payload: mergedMr('specd/setup', {
        project: { id: 111222, path_with_namespace: REPO_PATH, default_branch: 'main' },
      }),
    });
    expect(result.outcome).toBe('unmatched');
  });

  it('re-indexes a push that changes knowledge/ on the default branch', async () => {
    const before = reindexCalls.length;
    const result = await service.handle({
      deliveryId: randomUUID(),
      event: 'Push Hook',
      payload: {
        object_kind: 'push',
        ref: 'refs/heads/main',
        commits: [{ added: [], modified: ['knowledge/architecture.md'], removed: [] }],
        project: { id: GITLAB_PROJECT_ID, path_with_namespace: REPO_PATH, default_branch: 'main' },
      },
    });

    expect(result.outcome).toBe('reindex');
    expect(reindexCalls.length).toBe(before + 1);
  });

  it('ignores a push that touches only application code', async () => {
    const before = reindexCalls.length;
    const result = await service.handle({
      deliveryId: randomUUID(),
      event: 'Push Hook',
      payload: {
        object_kind: 'push',
        ref: 'refs/heads/main',
        commits: [{ added: [], modified: ['src/index.ts'], removed: [] }],
        project: { id: GITLAB_PROJECT_ID, path_with_namespace: REPO_PATH, default_branch: 'main' },
      },
    });

    expect(result.outcome).toBe('ignored');
    expect(reindexCalls.length).toBe(before);
  });

  it('ignores a delivery id that is not a uuid instead of erroring', async () => {
    const result = await service.handle({ deliveryId: 'not-a-uuid', event: 'Push Hook', payload: {} });
    expect(result.outcome).toBe('ignored');
    expect(result.detail).toContain('uuid');
  });

  it('records a handler failure on the delivery instead of throwing at GitLab', async () => {
    const broken = new GitLabWebhookService(
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
        reindex: async () => {
          throw new Error('database on fire');
        },
      } as unknown as PipelineService,
    );

    const deliveryId = randomUUID();
    const result = await broken.handle({
      deliveryId,
      event: 'Push Hook',
      payload: {
        object_kind: 'push',
        ref: 'refs/heads/main',
        commits: [{ added: [], modified: ['knowledge/a.md'], removed: [] }],
        project: { id: GITLAB_PROJECT_ID, path_with_namespace: REPO_PATH, default_branch: 'main' },
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

  it('falls back to matching by path when a repository has no external id', async () => {
    // A repository registered by hand (no picker, no externalId) must still
    // resolve — the id is the precise match, the path is the fallback that
    // makes `POST /projects/:slug/repositories` usable without it.
    const [handAdded] = await handle!.db
      .insert(repositories)
      .values({
        projectId,
        provider: 'gitlab',
        name: 'acme/hand-added',
        defaultBranch: 'main',
        setupBranch: 'specd/setup',
        setupState: 'open',
      })
      .returning();

    try {
      const before = reindexCalls.length;
      const result = await service.handle({
        deliveryId: randomUUID(),
        event: 'Push Hook',
        payload: {
          object_kind: 'push',
          ref: 'refs/heads/main',
          commits: [{ added: [], modified: ['knowledge/a.md'], removed: [] }],
          // No externalId was stored for this repository, so a numeric id
          // GitLab happens to send here cannot match it by id — only path.
          project: { id: 555444, path_with_namespace: 'acme/hand-added', default_branch: 'main' },
        },
      });

      expect(result.outcome).toBe('reindex');
      expect(reindexCalls.length).toBe(before + 1);
      expect(reindexCalls.at(-1)).toMatchObject({ repositoryIds: [handAdded!.id] });
    } finally {
      await handle!.db.delete(repositories).where(eq(repositories.id, handAdded!.id));
    }
  });

  it('does not resolve a webhook to a repository on a different GitLab instance sharing the same id and path', async () => {
    // Project ids and namespaced paths are unique only *within* a GitLab
    // instance. Two self-managed instances (or a self-managed instance and
    // gitlab.com) can each have their own, unrelated "project 9000" at
    // "shared/name" — web_url is what tells them apart, and a repository
    // whose own connection points at the other instance must be rejected as
    // a non-match, not merely logged as an ambiguous one.
    const stamp = Date.now();
    const [projectA] = await handle!.db
      .insert(projects)
      .values({ slug: `gl-inst-a-${stamp}`, name: 'Instance A project' })
      .returning();
    const [projectB] = await handle!.db
      .insert(projects)
      .values({ slug: `gl-inst-b-${stamp}`, name: 'Instance B project' })
      .returning();

    const [connA] = await handle!.db
      .insert(connections)
      .values({
        projectId: projectA!.id,
        kind: 'vcs',
        provider: 'gitlab',
        settings: { instanceUrl: 'https://gitlab-a.example.com' },
      })
      .returning();
    const [connB] = await handle!.db
      .insert(connections)
      .values({
        projectId: projectB!.id,
        kind: 'vcs',
        provider: 'gitlab',
        settings: { instanceUrl: 'https://gitlab-b.example.com' },
      })
      .returning();

    const [repoA] = await handle!.db
      .insert(repositories)
      .values({
        projectId: projectA!.id,
        connectionId: connA!.id,
        provider: 'gitlab',
        name: 'shared/name',
        externalId: '9000',
        defaultBranch: 'main',
      })
      .returning();
    const [repoB] = await handle!.db
      .insert(repositories)
      .values({
        projectId: projectB!.id,
        connectionId: connB!.id,
        provider: 'gitlab',
        name: 'shared/name',
        externalId: '9000',
        defaultBranch: 'main',
      })
      .returning();

    try {
      const before = reindexCalls.length;
      const result = await service.handle({
        deliveryId: randomUUID(),
        event: 'Push Hook',
        payload: {
          object_kind: 'push',
          ref: 'refs/heads/main',
          commits: [{ added: [], modified: ['knowledge/a.md'], removed: [] }],
          project: {
            id: 9000,
            path_with_namespace: 'shared/name',
            default_branch: 'main',
            web_url: 'https://gitlab-a.example.com/shared/name',
          },
        },
      });

      expect(result.outcome).toBe('reindex');
      expect(reindexCalls.length).toBe(before + 1);
      // Resolved to A's repository specifically — same id and path as B's,
      // disambiguated only by which instance actually sent the delivery.
      expect(reindexCalls.at(-1)).toMatchObject({ projectId: projectA!.id, repositoryIds: [repoA!.id] });
      expect(reindexCalls.at(-1)?.repositoryIds).not.toContain(repoB!.id);
    } finally {
      await handle!.db.delete(repositories).where(eq(repositories.id, repoA!.id));
      await handle!.db.delete(repositories).where(eq(repositories.id, repoB!.id));
      await handle!.db.delete(connections).where(eq(connections.id, connA!.id));
      await handle!.db.delete(connections).where(eq(connections.id, connB!.id));
      await handle!.db.delete(projects).where(eq(projects.id, projectA!.id));
      await handle!.db.delete(projects).where(eq(projects.id, projectB!.id));
    }
  });
});
