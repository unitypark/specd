import { createHash } from 'node:crypto';
import { createDb, projects, repositories, type DbHandle, type Repository } from '@specd/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Config } from '../config.js';
import { EmbeddingService } from './embeddings.js';
import { KnowledgeService } from './knowledge.service.js';
import type { VcsService } from '../vcs/vcs.service.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://specd:specd@localhost:5433/specd';

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

const files = new Map<string, string>();

const fakeVcs = {
  adapterFor: async () => ({
    listFiles: async () => [...files.keys()],
    listFilesWithSha: async () =>
      [...files.entries()].map(([path, content]) => ({
        path,
        sha: createHash('sha1').update(content).digest('hex'),
      })),
    readFiles: async (_t: unknown, paths: string[]) =>
      paths.filter((p) => files.has(p)).map((p) => ({ path: p, content: files.get(p)! })),
  }),
  toTarget: () => ({}),
  localAdapter: { lastCommitDate: async () => null, commitFiles: async () => [] },
} as unknown as VcsService;

let handle: DbHandle | null = null;
let service: KnowledgeService;
let projectId = '';
let repo: Repository;

/**
 * The index-run digest (plan № 3, 2.2). What matters is that it describes the
 * run that actually landed: written inside the same transaction, so a rolled
 * back run leaves nothing behind claiming work that never happened.
 */
describe.skipIf(!reachable)('the index-run digest (integration)', () => {
  beforeAll(async () => {
    handle = createDb(DATABASE_URL, { max: 2 });
    process.env.DATABASE_URL ??= DATABASE_URL;
    process.env.JWT_SECRET ??= 'test';
    process.env.VAULT_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
    service = new KnowledgeService(handle.db, handle, fakeVcs, new EmbeddingService(new Config()));

    const [project] = await handle.db
      .insert(projects)
      .values({ slug: `digest-test-${Date.now()}`, name: 'Digest Test' })
      .returning();
    projectId = project!.id;
    const [repoRow] = await handle.db
      .insert(repositories)
      .values({ projectId, provider: 'local', name: 'test/kb', isPrimary: true })
      .returning();
    repo = repoRow!;
  }, 60_000);

  afterAll(async () => {
    if (handle) {
      if (projectId) await handle.db.delete(projects).where(eq(projects.id, projectId));
      await handle.close();
    }
  });

  it('reports a first run as added, with no before to compare against', async () => {
    files.clear();
    files.set('knowledge/architecture.md', '# Architecture\n\n## Runtime\n\nPostgres only.\n');
    files.set('knowledge/product.md', '# Product\n\nWhat it is for.\n');
    await service.indexRepository(repo);

    const [run] = await service.indexRuns(projectId);
    expect(run).toBeDefined();
    expect(run!.repo_name).toBe('test/kb');
    expect(run!.docs_added).toBe(2);
    expect(run!.docs_changed).toBe(0);
    expect(run!.docs_removed).toBe(0);
    // No previous run, so no previous score. Reporting 0 here would read as a
    // collapse from a perfect score rather than as the absence it is.
    expect(run!.health_before).toBeNull();
    expect(run!.health_after).not.toBeNull();
  });

  it('tells a changed doc apart from an added one, and from a removed one', async () => {
    files.set('knowledge/architecture.md', '# Architecture\n\n## Runtime\n\nPostgres and pgvector.\n');
    files.set('knowledge/testing.md', '# Testing\n\nVitest.\n');
    files.delete('knowledge/product.md');
    await service.indexRepository(repo);

    const [run] = await service.indexRuns(projectId);
    expect(run!.docs_added).toBe(1);
    expect(run!.docs_changed).toBe(1);
    expect(run!.docs_removed).toBe(1);
    // A second run has a before.
    expect(run!.health_before).not.toBeNull();
  });

  it('says nothing new when nothing changed', async () => {
    await service.indexRepository(repo);
    const [run] = await service.indexRuns(projectId);
    expect(run!.docs_added).toBe(0);
    expect(run!.docs_changed).toBe(0);
    expect(run!.docs_removed).toBe(0);
  });

  it('keeps the runs in order, newest first', async () => {
    const runs = await service.indexRuns(projectId);
    expect(runs.length).toBeGreaterThanOrEqual(3);
    const times = runs.map((r) => new Date(r.created_at).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('counts links, and a broken one as broken', async () => {
    files.set(
      'knowledge/architecture.md',
      ['# Architecture', '', '## Runtime', '', 'Postgres only.',
       'See per knowledge/testing.md#top and per knowledge/gone.md#nope.'].join('\n'),
    );
    await service.indexRepository(repo);

    const [run] = await service.indexRuns(projectId);
    // A citation to a doc that is not there is the signal this count exists for.
    expect(run!.links_broken).toBeGreaterThan(0);
  });

  it('leaves no digest behind when the run rolls back', async () => {
    const before = await service.indexRuns(projectId, 100);

    // The shrink guard refuses a listing that would gut the index, and the
    // whole transaction rolls back with it — including the digest, which must
    // not survive to describe work that never landed.
    const kept = new Map(files);
    files.clear();
    await expect(service.indexRepository(repo)).rejects.toThrow(/Refusing to re-index/);
    for (const [k, v] of kept) files.set(k, v);

    const after = await service.indexRuns(projectId, 100);
    expect(after.length).toBe(before.length);
  });
});
