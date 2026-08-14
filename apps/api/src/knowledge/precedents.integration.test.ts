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

/**
 * Precedent lookup (plan № 3, 2.1). The behaviour worth pinning is the scoping:
 * `knowledge/specs/` and `knowledge/decisions/` answer "what happened when we
 * last built something like this", and every other doc answers a different
 * question. A lookup that lets architecture prose in is just retrieval with
 * extra steps.
 */
describe.skipIf(!reachable)('precedents (integration)', () => {
  beforeAll(async () => {
    handle = createDb(DATABASE_URL, { max: 2 });
    process.env.DATABASE_URL ??= DATABASE_URL;
    process.env.JWT_SECRET ??= 'test';
    process.env.VAULT_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
    service = new KnowledgeService(handle.db, handle, fakeVcs, new EmbeddingService(new Config()));

    const [project] = await handle.db
      .insert(projects)
      .values({ slug: `precedent-test-${Date.now()}`, name: 'Precedent Test' })
      .returning();
    projectId = project!.id;

    const [repoRow] = await handle.db
      .insert(repositories)
      .values({ projectId, provider: 'local', name: 'test/kb', isPrimary: true })
      .returning();

    files.clear();
    // An as-built spec that diverged, and says so.
    files.set(
      'knowledge/specs/S-100-runner-job-dispatch.md',
      [
        '<!-- Filed automatically by specd when S-100 was built. -->',
        '# S-100 — Runner job dispatch',
        '',
        '## Design',
        '',
        'A paired runner polls for queued jobs and claims one with SKIP LOCKED.',
        '',
        '## Verification',
        '',
        '`pnpm test` — passed',
        '',
        '## Deviations',
        '',
        'Task 3 ran on the merge poll instead of the webhook.',
      ].join('\n'),
    );
    // An as-built spec whose verify never ran — the outcome a boolean loses.
    files.set(
      'knowledge/specs/S-101-runner-leases.md',
      [
        '# S-101 — Runner leases',
        '',
        '## Design',
        '',
        'A runner heartbeats its lease so a dead machine releases its claim.',
        '',
        '## Verification',
        '',
        '`pnpm test` — not run',
      ].join('\n'),
    );
    files.set(
      'knowledge/decisions/0004-runner-job-dispatch.md',
      '# 0004 — Runner job dispatch\n\n## Context\n\nA runner claims a queued job by polling.\n',
    );
    // Same vocabulary, different kind. If this shows up, the scoping is broken
    // — and it would, because it is the doc the general ranking prefers.
    files.set(
      'knowledge/architecture.md',
      '# Architecture\n\n## Runners\n\nA runner claims a queued job by polling. Leases heartbeat.\n',
    );
    files.set('knowledge/runbooks/local-dev.md', '# Local dev\n\nRunner jobs run locally too.\n');

    await service.indexRepository(repoRow as Repository);
  }, 60_000);

  afterAll(async () => {
    if (handle) {
      if (projectId) await handle.db.delete(projects).where(eq(projects.id, projectId));
      await handle.close();
    }
  });

  it('answers with history, not with architecture', async () => {
    const found = await service.findPrecedents(projectId, 'how does a runner claim a queued job');
    expect(found.length).toBeGreaterThan(0);

    const paths = found.map((p) => p.path);
    expect(paths).toContain('knowledge/specs/S-100-runner-job-dispatch.md');
    // The doc a general retrieval would have ranked first.
    expect(paths).not.toContain('knowledge/architecture.md');
    expect(paths).not.toContain('knowledge/runbooks/local-dev.md');
    expect(found.every((p) => p.kind === 'spec' || p.kind === 'adr')).toBe(true);
  });

  it('reports one row per document, best first', async () => {
    const found = await service.findPrecedents(projectId, 'runner claims a queued job');
    expect(new Set(found.map((p) => p.path)).size).toBe(found.length);
    const scores = found.map((p) => p.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('carries the outcome, including the one a boolean would lose', async () => {
    const dispatch = await service.findPrecedents(projectId, 'runner polls for queued jobs', 8);
    const diverged = dispatch.find((p) => p.path.includes('S-100'));
    expect(diverged?.verification).toBe('`pnpm test` — passed');
    expect(diverged?.hasDeviations).toBe(true);

    const leases = await service.findPrecedents(projectId, 'runner heartbeats its lease', 8);
    const unrun = leases.find((p) => p.path.includes('S-101'));
    // Not "failed", not "passed" — nobody ran it, and that is the fact.
    expect(unrun?.verification).toBe('`pnpm test` — not run');
    expect(unrun?.hasDeviations).toBe(false);
  });

  it('names the repository, because a path alone is ambiguous', async () => {
    const found = await service.findPrecedents(projectId, 'runner claims a queued job');
    expect(found.every((p) => p.repoName === 'test/kb')).toBe(true);
  });

  it('says why each precedent surfaced', async () => {
    const found = await service.findPrecedents(projectId, 'runner claims a queued job');
    // A rank with no reason is a number a reviewer has to trust blindly; the
    // heading is what lets them judge the match themselves.
    expect(found.some((p) => p.matchedOn !== null)).toBe(true);
  });

  it('answers a whole ticket, not just a tidy phrase', async () => {
    // The shape `SpecAgent.prepare()` actually sends: `${title}\n${body}`.
    // Every other test here passes a hand-written phrase, and a lexical
    // predicate that ANDs its terms passes all of them while returning
    // nothing for this — the feature would be inert in production and green
    // in CI. Any change to the lexical arm has to keep this passing.
    const ticket = [
      'Runner job dispatch is dropping jobs under load',
      '',
      'When several machines are paired and a burst of specs is approved at once,',
      'some queued jobs are never claimed by anybody and sit until someone notices.',
      'We think two runners may be racing for the same row. Can we make the claim',
      'atomic, and can an abandoned job find its way back into the queue?',
    ].join('\n');

    const found = await service.findPrecedents(projectId, ticket);
    expect(found.length).toBeGreaterThan(0);
    expect(found.map((p) => p.path)).toContain('knowledge/specs/S-100-runner-job-dispatch.md');
  });

  it('has nothing to say about ground nobody has walked', async () => {
    expect(await service.findPrecedents(projectId, 'kubernetes ingress tls termination')).toEqual(
      [],
    );
  });
});
