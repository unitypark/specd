import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  createDb,
  knowledgeDocLinks,
  knowledgeDocs,
  projects,
  repositories,
  type DbHandle,
  type Repository,
} from '@specd/db';
import { KnowledgeService } from './knowledge.service.js';
import { EmbeddingService } from './embeddings.js';
import type { VcsService } from '../vcs/vcs.service.js';
import { Config } from '../config.js';

/**
 * The graph lifecycle end to end (S-102), through the real `indexRepository`
 * entry point with a fake VCS adapter holding an in-memory file tree — so
 * incremental behaviour (sha-skip, per-doc link replacement, re-resolution)
 * is exercised exactly the way a webhook-triggered re-index exercises it.
 */

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

/** Mutable fake tree; the adapter reads whatever is here right now. */
const files = new Map<string, string>();

const fakeVcs = {
  adapterFor: async () => ({
    listFiles: async () => [...files.keys()],
    readFiles: async (_t: unknown, paths: string[]) =>
      paths.filter((p) => files.has(p)).map((p) => ({ path: p, content: files.get(p)! })),
  }),
  toTarget: () => ({}),
  localAdapter: { lastCommitDate: async () => null },
} as unknown as VcsService;

let handle: DbHandle | null = null;
let service: KnowledgeService;
let projectId = '';
let repo: Repository;

const linkRows = () =>
  handle!.db
    .select()
    .from(knowledgeDocLinks)
    .where(eq(knowledgeDocLinks.projectId, projectId));

const docByPath = async (path: string) => {
  const [row] = await handle!.db
    .select()
    .from(knowledgeDocs)
    .where(and(eq(knowledgeDocs.projectId, projectId), eq(knowledgeDocs.path, path)))
    .limit(1);
  return row ?? null;
};

describe.skipIf(!reachable)('knowledge graph (integration)', () => {
  beforeAll(async () => {
    handle = createDb(DATABASE_URL, { max: 2 });
    process.env.DATABASE_URL ??= DATABASE_URL;
    process.env.JWT_SECRET ??= 'test';
    process.env.VAULT_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
    const config = new Config();
    service = new KnowledgeService(handle.db, handle, fakeVcs, new EmbeddingService(config));

    const [project] = await handle.db
      .insert(projects)
      .values({ slug: `graph-test-${Date.now()}`, name: 'Graph Test' })
      .returning();
    projectId = project!.id;

    const [repoRow] = await handle.db
      .insert(repositories)
      .values({ projectId, provider: 'local', name: 'test/kb', isPrimary: true })
      .returning();
    repo = repoRow!;

    files.set(
      'knowledge/decisions/0001-first.md',
      [
        '# 0001 — First decision',
        '',
        '## Context',
        '',
        'Builds on [[0002-second]] and per knowledge/architecture.md#runtime today.',
        'Also cites per knowledge/architecture.md#no-such-anchor sometimes.',
        'And references [[0009-not-written-yet]] which does not exist.',
        'The daemon details live in `docs/runners.md` and [the readme](../../README.md).',
      ].join('\n'),
    );
    // Deliberately shares NO vocabulary with the retrieval query below —
    // reachable only through 0001's wikilink, or the expansion test proves
    // nothing.
    files.set('knowledge/decisions/0002-second.md', '# 0002 — Atomic claim ordering\n\nPostgres SKIP LOCKED semantics.\n');
    files.set('knowledge/architecture.md', '# Architecture\n\n## Runtime\n\nPostgres only. Retrieval is hybrid.\n');
    files.set('knowledge/orphan.md', '# Orphan\n\nNothing links here.\n');

    await service.indexRepository(repo);
  });

  afterAll(async () => {
    if (handle) {
      await handle.db.delete(projects).where(eq(projects.id, projectId));
      await handle.close();
    }
  });

  it('extracts and resolves the graph on first index', async () => {
    const links = await linkRows();
    const byTarget = (raw: string) => links.find((l) => l.rawTarget === raw);

    const wiki = byTarget('0002-second');
    expect(wiki?.resolutionState).toBe('resolved');
    expect(wiki?.kind).toBe('wikilink');
    expect(wiki?.site).toBe('context');

    const cite = byTarget('knowledge/architecture.md');
    expect(cite).toBeTruthy();

    const missing = byTarget('0009-not-written-yet');
    expect(missing?.resolutionState).toBe('unresolved');
    expect(missing?.resolvedDocId).toBeNull();

    // References to real files OUTSIDE knowledge/ are out of scope, not
    // broken — storing them as unresolved was the first live run's false
    // alarm, and they must not appear at all.
    expect(byTarget('docs/runners.md')).toBeUndefined();
    expect(byTarget('../../README.md')).toBeUndefined();
  });

  it('marks a citation whose anchor does not exist as dangling, not resolved', async () => {
    const links = await linkRows();
    const anchors = links.filter((l) => l.rawTarget === 'knowledge/architecture.md');
    const states = new Set(anchors.map((l) => `${l.resolvedAnchor}:${l.resolutionState}`));
    expect(states.has('runtime:resolved')).toBe(true);
    expect(states.has('no-such-anchor:dangling_anchor')).toBe(true);
  });

  it('binds an old unresolved link when its target is created later, without re-indexing the source', async () => {
    const before = await docByPath('knowledge/decisions/0001-first.md');
    files.set('knowledge/decisions/0009-not-written-yet.md', '# 0009 — Now it exists\n\nBody.\n');
    await service.indexRepository(repo);

    // The source doc was sha-skipped — same row, untouched content — yet its
    // dangling edge is now green. That is the re-resolution pass working.
    const after = await docByPath('knowledge/decisions/0001-first.md');
    expect(after?.sha).toBe(before?.sha);

    const links = await linkRows();
    const healed = links.find((l) => l.rawTarget === '0009-not-written-yet');
    expect(healed?.resolutionState).toBe('resolved');
    expect(healed?.resolvedDocId).toBeTruthy();
  });

  it('demotes links whose target is deleted back to unresolved', async () => {
    files.delete('knowledge/decisions/0009-not-written-yet.md');
    await service.indexRepository(repo);

    const links = await linkRows();
    const demoted = links.find((l) => l.rawTarget === '0009-not-written-yet');
    expect(demoted?.resolutionState).toBe('unresolved');
    expect(demoted?.resolvedDocId).toBeNull();
  });

  it('reports broken links, dangling anchors and orphans in health notes', async () => {
    const health = await service.health(projectId);
    const text = (health.notes as { text: string }[]).map((n) => n.text).join(' | ');
    expect(text).toMatch(/link.*point at nothing/);
    expect(text).toMatch(/anchor.*no longer exist/);
  });

  it('serves links and backlinks per doc', async () => {
    const source = await docByPath('knowledge/decisions/0001-first.md');
    const target = await docByPath('knowledge/decisions/0002-second.md');

    const sourceLinks = await service.docLinks(projectId, source!.id);
    expect(sourceLinks.outbound.some((l) => l.targetPath === 'knowledge/decisions/0002-second.md')).toBe(true);
    expect(sourceLinks.outbound.some((l) => l.state === 'unresolved')).toBe(true);

    const targetLinks = await service.docLinks(projectId, target!.id);
    expect(targetLinks.backlinks).toHaveLength(1);
    expect(targetLinks.backlinks[0]).toMatchObject({
      sourcePath: 'knowledge/decisions/0001-first.md',
      kind: 'wikilink',
      site: 'context',
    });
  });

  it('expands retrieval one hop with graph provenance, never displacing RRF picks', async () => {
    // The query matches 0001 hard; 0002 shares no query vocabulary and is
    // reachable only through 0001's wikilink. limit=1 keeps the corpus's
    // other docs out of the seed set — in a four-doc index a generous limit
    // would seat everything as an RRF pick and leave nothing to expand to.
    const result = await service.retrieve(projectId, 'first decision context builds', 1);

    expect(result.chunks.length).toBeGreaterThan(0);
    const rrf = result.chunks.filter((c) => c.via !== 'graph');
    const graph = result.chunks.filter((c) => c.via === 'graph');

    // RRF picks come first, expansion strictly appends.
    const firstGraphIndex = result.chunks.findIndex((c) => c.via === 'graph');
    if (firstGraphIndex !== -1) {
      expect(result.chunks.slice(firstGraphIndex).every((c) => c.via === 'graph')).toBe(true);
    }

    expect(rrf.some((c) => c.path === 'knowledge/decisions/0001-first.md')).toBe(true);
    const expanded = graph.find((c) => c.path === 'knowledge/decisions/0002-second.md');
    expect(expanded).toBeTruthy();
    expect(expanded?.viaEdge).toMatch(/wikilink at knowledge\/decisions\/0001-first\.md#context/);

    // The orphan is not reachable by any edge and must not be expanded to.
    expect(graph.some((c) => c.path === 'knowledge/orphan.md')).toBe(false);
  });

  it('does not expand through a hub that was not itself a seed', async () => {
    // 22 stub docs all link to the hub; the hub links to 0002. Degree > 20.
    files.set('knowledge/hub.md', '# Hub\n\nIndex of everything, see [[0002-second]].\n');
    for (let i = 0; i < 22; i += 1) {
      files.set(`knowledge/stubs/stub-${i}.md`, `# Stub ${i}\n\nSee [[hub]] for the index.\n`);
    }
    await service.indexRepository(repo);

    const result = await service.retrieve(projectId, 'first decision context builds', 4);
    expect(result.chunks.some((c) => c.via === 'graph' && c.path === 'knowledge/hub.md')).toBe(false);

    for (let i = 0; i < 22; i += 1) files.delete(`knowledge/stubs/stub-${i}.md`);
    files.delete('knowledge/hub.md');
    // Removing 23 of ~28 docs would trip the shrink guard — as it should.
    await expect(service.indexRepository(repo)).rejects.toThrow(/Refusing to re-index/);

    // Clean up the way the guard's own message prescribes for a real mass
    // deletion: take the docs out of the index directly, then re-index.
    await handle!.sql`
      DELETE FROM knowledge_docs
      WHERE project_id = ${projectId}
        AND (path LIKE 'knowledge/stubs/%' OR path = 'knowledge/hub.md')
    `;
    await service.indexRepository(repo);
  });

  it('backfills links for docs indexed before the graph existed, without re-embedding', async () => {
    // Simulate the pre-graph world: a doc with a current sha but version-0
    // stamp and no link rows — exactly what an already-indexed tree looks
    // like the first time this feature runs against it.
    const doc = await docByPath('knowledge/decisions/0001-first.md');
    await handle!.db
      .update(knowledgeDocs)
      .set({ linksVersion: 0 })
      .where(eq(knowledgeDocs.id, doc!.id));
    await handle!.db.delete(knowledgeDocLinks).where(eq(knowledgeDocLinks.sourceDocId, doc!.id));

    const result = await service.indexRepository(repo);

    // Sha-skipped — not re-indexed — yet its edges are back.
    expect(result.indexed).toBe(0);
    const links = await linkRows();
    expect(links.some((l) => l.sourceDocId === doc!.id && l.rawTarget === '0002-second')).toBe(true);

    const [stamped] = await handle!.db
      .select({ linksVersion: knowledgeDocs.linksVersion })
      .from(knowledgeDocs)
      .where(eq(knowledgeDocs.id, doc!.id));
    expect(stamped?.linksVersion).toBeGreaterThan(0);
  });

  it('refuses a listing that would gut the index, leaving everything intact', async () => {
    const storedBefore = await handle!.db
      .select({ id: knowledgeDocs.id })
      .from(knowledgeDocs)
      .where(eq(knowledgeDocs.projectId, projectId));

    const stash = new Map(files);
    files.clear();
    await expect(service.indexRepository(repo)).rejects.toThrow(/Refusing to re-index/);
    for (const [k, v] of stash) files.set(k, v);

    const storedAfter = await handle!.db
      .select({ id: knowledgeDocs.id })
      .from(knowledgeDocs)
      .where(eq(knowledgeDocs.projectId, projectId));
    expect(storedAfter.length).toBe(storedBefore.length);
  });
});
