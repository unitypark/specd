import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

/** Mutable so a test can give the repo a commit history to drift against. */
let fakeCommitDate: Date | null = null;
/** Commit history the fake repo reports, for coupling (0013). */
let fakeHistory: { sha: string; at: Date; files: string[] }[] = [];

const fakeVcs = {
  adapterFor: async () => ({
    listFiles: async () => [...files.keys()],
    readFiles: async (_t: unknown, paths: string[]) =>
      paths.filter((p) => files.has(p)).map((p) => ({ path: p, content: files.get(p)! })),
  }),
  toTarget: () => ({}),
  localAdapter: {
    lastCommitDate: async () => fakeCommitDate,
    commitFiles: async () => fakeHistory,
  },
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

const chunkCount = async (docId: string) => {
  const [row] = await handle!.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM knowledge_chunks WHERE doc_id = ${docId}
  `;
  return Number(row?.n ?? 0);
};

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
    // Body text before the first heading chunks with a null heading — the one
    // shape the batched chunk insert has to carry through `unnest`.
    files.set(
      'knowledge/preamble.md',
      'Loose prose before any heading at all.\n\n# Preamble\n\nAnd a section after it.\n',
    );

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

  it('indexes a chunk that has no heading', async () => {
    const doc = await docByPath('knowledge/preamble.md');
    const rows = await handle!.sql<{ heading: string | null; embedding: string | null }[]>`
      SELECT heading, embedding::text FROM knowledge_chunks WHERE doc_id = ${doc!.id} ORDER BY ord
    `;
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0]?.heading).toBeNull();
    expect(rows[0]?.embedding).toBeTruthy();
    expect(rows.some((r) => r.heading === 'Preamble')).toBe(true);
  });

  it('re-embeds a doc whose chunker or embedder changed, though its sha did not', async () => {
    // The blind spot in a content-hash skip: the source is identical, but the
    // rows behind it were built by a chunker or an embedder that is no longer
    // the one in use. Left alone, that puts two vector spaces in one index.
    const before = await docByPath('knowledge/architecture.md');
    await handle!.db
      .update(knowledgeDocs)
      .set({ indexFingerprint: 'chunk=v0/900/50;embed=hash/hash-ngram-v0/512' })
      .where(eq(knowledgeDocs.id, before!.id));

    const logs: string[] = [];
    await service.indexRepository(repo, async (msg) => {
      logs.push(msg);
    });

    expect(logs.some((l) => l.includes('re-embedded'))).toBe(true);
    expect(logs.some((l) => l.includes('indexed knowledge/architecture.md'))).toBe(true);

    const after = await docByPath('knowledge/architecture.md');
    expect(after?.sha).toBe(before?.sha); // the source never moved
    expect(after?.indexFingerprint).toContain('embed=hash/hash-ngram-v1/1024');
    expect(await chunkCount(after!.id)).toBeGreaterThan(0);
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

    // The label says which edge in words; the id is the same fact as a key.
    // Two docs can be linked more than once, so only the id identifies which
    // edge actually fired (S-102 asked for it and shipped without it).
    expect(expanded?.viaEdgeId).toBeTruthy();
    const [edge] = await handle!.db
      .select()
      .from(knowledgeDocLinks)
      .where(eq(knowledgeDocLinks.id, expanded!.viaEdgeId!));
    expect(edge).toMatchObject({
      kind: 'wikilink',
      rawTarget: '0002-second',
      resolutionState: 'resolved',
    });

    // Scored, not zeroed: a neighbour is evidence at one remove, so it ranks
    // below the seed that reached it rather than reporting no strength at all.
    const seed = rrf.find((c) => c.path === 'knowledge/decisions/0001-first.md');
    expect(expanded!.score).toBeGreaterThan(0);
    expect(expanded!.score).toBeLessThan(seed!.score);

    // The orphan is not reachable by any edge and must not be expanded to.
    expect(graph.some((c) => c.path === 'knowledge/orphan.md')).toBe(false);
  });

  it('reports truncation only when the corpus really had more to give', async () => {
    // The notice has to mean something. Counting the fusion pool made it fire
    // on every query — the dense arm has no relevance threshold, so it always
    // returns a full pool — and an agent that sees "42 omitted" on every draft
    // stops reading the line.
    const generous = await service.retrieve(projectId, 'atomic claim ordering', 14);
    expect(generous.chunks.length).toBeGreaterThan(0);
    expect(generous.matchedCount).toBeLessThanOrEqual(generous.chunks.length);
    expect(generous.truncatedCount).toBe(0);

    // A query matching nothing lexically claims nothing was cut.
    const nomatch = await service.retrieve(projectId, 'zzzqqq nonexistent vocabulary', 14);
    expect(nomatch.matchedCount).toBe(0);
    expect(nomatch.truncatedCount).toBe(0);

    // And a genuinely narrow window does report the remainder.
    const narrow = await service.retrieve(projectId, 'postgres', 1);
    if (narrow.matchedCount > 1) {
      expect(narrow.truncatedCount).toBe(narrow.matchedCount - 1);
    }
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

  it('reports graph rot as numbers, not only as sentences', async () => {
    // The counts existed only inside note strings, so nothing could badge,
    // sort or trend them and they contributed nothing to the score describing
    // them. Numbers and prose now have to agree.
    const health = await service.health(projectId);
    const text = (health.notes as { text: string }[]).map((n) => n.text).join(' | ');

    expect(health.brokenLinks).toBeGreaterThan(0);
    expect(health.danglingAnchors).toBeGreaterThan(0);
    expect(text).toContain(`${health.brokenLinks} link`);
    expect(text).toContain(`${health.danglingAnchors} citation anchor`);
    expect(health.score).toBeLessThan(100);
  });

  it('does not count the map itself as an orphan', async () => {
    // An index page has no inbound links by construction. Dinging every
    // project for it forever would make the score unreachable, and a score
    // nobody can clear is a score nobody reads.
    const before = (await service.health(projectId)).orphanDocs;

    files.set('knowledge/README.md', '# knowledge/\n\nStart here. Nothing links to me.\n');
    await service.indexRepository(repo);
    expect((await service.health(projectId)).orphanDocs).toBe(before);

    // …while an ordinary unlinked doc still counts.
    files.set('knowledge/nobody-links-here.md', '# Nobody\n\nUnreferenced.\n');
    await service.indexRepository(repo);
    expect((await service.health(projectId)).orphanDocs).toBe(before + 1);

    files.delete('knowledge/nobody-links-here.md');
    await service.indexRepository(repo);
  });

  it('says freshness is unknown rather than good when there is no commit date', async () => {
    // Falling back to indexedAt reported every doc of a hosted repo as
    // permanently fresh — a false negative hiding the rot the number exists
    // to expose.
    const docs = await service.listDocs(projectId);
    const doc = docs.find((d) => d.path === 'knowledge/orphan.md');
    expect(doc?.freshness.unknown).toBe(true);
    expect(doc?.freshness.stale).toBe(false);
    expect(doc?.freshness.ageDays).toBeNull();
    expect((await service.health(projectId)).unknownFreshnessCount).toBeGreaterThan(0);
  });

  it('calls a doc drifted when code moved under it, not merely when time passed', async () => {
    // The fallback path: this doc has never moved with any code, so there is
    // no coupling to measure against and the blunt repo-wide count is all
    // there is. Still better than the calendar.
    fakeCommitDate = new Date(Date.now() - 5 * 86_400_000); // touched 5 days ago
    // …and the code moved after that, which is the only ordering that counts.
    fakeHistory = Array.from({ length: 12 }, (_, i) => ({
      sha: `d${i}`,
      at: new Date(Date.now() - 4 * 86_400_000 + i * 3_600_000),
      files: [`apps/api/src/unrelated/f${i}.ts`],
    }));
    files.set('knowledge/orphan.md', '# Orphan\n\nNothing links here. Edited.\n');
    await service.indexRepository(repo);

    const doc = (await service.listDocs(projectId)).find((d) => d.path === 'knowledge/orphan.md');
    // Five days old: the 90-day timer would call this fresh. The codebase says
    // otherwise, and that is the claim knowledge/README.md has always made.
    expect(doc?.freshness.unknown).toBe(false);
    expect(doc?.freshness.stale).toBe(true);
    expect(doc?.freshness.reason).toContain('12 commits touched code');

    fakeCommitDate = null;
    fakeHistory = [];
  });

  it('gives a chunk an anchor the coverage set actually contains', async () => {
    // The invariant citation checking rests on: the anchor a retrieved chunk
    // advertises must be findable in the doc's real heading set. Two
    // slugifiers meant that failed for anything outside ASCII, so a sound
    // citation to a unicode heading was reported as unchecked.
    files.set(
      'knowledge/unicode.md',
      '# Unicode\n\n## Café notes\n\nSigned URLs expire after fifteen minutes in München.\n',
    );
    await service.indexRepository(repo);

    const result = await service.retrieve(projectId, 'café notes münchen signed urls', 6);
    const chunk = result.chunks.find((c) => c.path === 'knowledge/unicode.md');
    expect(chunk?.heading).toBe('café-notes');

    const coverage = await service.coverageFor(projectId, ['knowledge/unicode.md']);
    expect(coverage.anchorsByPath['knowledge/unicode.md']).toContain(chunk!.heading!);

    files.delete('knowledge/unicode.md');
    await service.indexRepository(repo);
  });

  it('mines doc↔code coupling from history and drifts on it', async () => {
    // The signal the file tree cannot give: files that change together are
    // coupled whatever the imports say. Here architecture.md moved with the
    // API twice, and the API has moved twelve times since — past the drift
    // threshold — so the doc is drifted even though it was edited two days ago.
    const at = (n: number) => new Date(Date.UTC(2026, 0, n));
    fakeCommitDate = new Date(Date.now() - 2 * 86_400_000);
    fakeHistory = [
      { sha: 'a1', at: at(1), files: ['knowledge/architecture.md', 'apps/api/src/knowledge/x.ts'] },
      { sha: 'a2', at: at(2), files: ['knowledge/architecture.md', 'apps/api/src/knowledge/y.ts'] },
      ...Array.from({ length: 12 }, (_, i) => ({
        sha: `b${i}`,
        at: at(3 + i),
        files: [`apps/api/src/knowledge/z${i}.ts`],
      })),
      // A sweep that must not couple anything to everything.
      {
        sha: 'sweep',
        at: at(20),
        files: [
          'knowledge/glossary.md',
          ...Array.from({ length: 60 }, (_, i) => `apps/web/src/f${i}.ts`),
        ],
      },
    ];

    files.set('knowledge/architecture.md', '# Architecture\n\n## Runtime\n\nPostgres only. Retrieval is hybrid. Edited.\n');
    await service.indexRepository(repo);

    const doc = await docByPath('knowledge/architecture.md');
    const coupling = await service.docCoupling(projectId, doc!.id);
    expect(coupling[0]).toMatchObject({
      codePath: 'apps/api/src/',
      commitsTogether: 2,
      commitsSince: 12,
    });

    // Two days old, so the 90-day timer would call it fresh; the codebase
    // disagrees, and the reason names the area to go and read.
    const listed = (await service.listDocs(projectId)).find(
      (d) => d.path === 'knowledge/architecture.md',
    );
    expect(listed?.freshness.stale).toBe(true);
    expect(listed?.freshness.reason).toContain('apps/api/src/');

    // The sweep is excluded, so the glossary is coupled to nothing.
    const glossary = await docByPath('knowledge/orphan.md');
    expect(await service.docCoupling(projectId, glossary!.id)).toEqual([]);

    fakeHistory = [];
    fakeCommitDate = null;
    files.set('knowledge/architecture.md', '# Architecture\n\n## Runtime\n\nPostgres only. Retrieval is hybrid.\n');
    await service.indexRepository(repo);
  });

  it('mines the same coupling for a repo it cannot clone', async () => {
    // A hosted repo has no working tree, so history arrives from push
    // webhooks instead of git log. Everything downstream is identical — the
    // point of routing both providers through one history source.
    const [hosted] = await handle!.db
      .insert(repositories)
      .values({ projectId, provider: 'github', name: 'acme/hosted', externalId: '99' })
      .returning();

    const at = (n: number) => new Date(Date.now() - (30 - n) * 86_400_000);
    await service.recordCommits(hosted!, [
      { sha: 'h1', at: at(1), files: ['knowledge/hosted.md', 'apps/api/src/pay/a.ts'] },
      { sha: 'h2', at: at(2), files: ['knowledge/hosted.md', 'apps/api/src/pay/b.ts'] },
      ...Array.from({ length: 12 }, (_, i) => ({
        sha: `hc${i}`,
        at: at(3 + i),
        files: [`apps/api/src/pay/c${i}.ts`],
      })),
    ]);

    // Redelivery is normal; the ledger must not double-count it.
    await service.recordCommits(hosted!, [
      { sha: 'h1', at: at(1), files: ['knowledge/hosted.md', 'apps/api/src/pay/a.ts'] },
    ]);

    files.set('knowledge/hosted.md', '# Hosted\n\nPayments live here.\n');
    await service.indexRepository(hosted!);

    const doc = await docByPath('knowledge/hosted.md');
    const coupling = await service.docCoupling(projectId, doc!.id);
    expect(coupling[0]).toMatchObject({
      codePath: 'apps/api/src/',
      commitsTogether: 2,
      commitsSince: 12,
    });

    // And the freshness that used to be permanently "unmeasured" on a hosted
    // repo now has a date behind it, derived from the ledger.
    const listed = (await service.listDocs(projectId)).find((d) => d.path === 'knowledge/hosted.md');
    expect(listed?.freshness.unknown).toBe(false);
    expect(listed?.freshness.stale).toBe(true);
    expect(listed?.freshness.reason).toContain('apps/api/src/');

    files.delete('knowledge/hosted.md');
    await handle!.db.delete(repositories).where(eq(repositories.id, hosted!.id));
  });

  it('rolls the whole run back when a step fails partway through', async () => {
    // The failure this exists to prevent: a doc's chunks are deleted before
    // its new ones are written, so a run that dies in between leaves the doc
    // indexed-looking and unretrievable. Health recomputation stands in for
    // any late failure — it is the last thing inside the transaction.
    const path = 'knowledge/architecture.md';
    const original = files.get(path)!;
    const before = await docByPath(path);
    const chunksBefore = await chunkCount(before!.id);
    expect(chunksBefore).toBeGreaterThan(0);

    files.set(path, `${original}\n\n## Added section\n\nA paragraph that changes the sha.\n`);
    const boom = vi
      .spyOn(service, 'recomputeHealth')
      .mockRejectedValueOnce(new Error('health recompute exploded'));

    await expect(service.indexRepository(repo)).rejects.toThrow(/exploded/);
    boom.mockRestore();

    // Nothing landed: not the doc row, not the chunks it had already replaced.
    const after = await docByPath(path);
    expect(after?.sha).toBe(before?.sha);
    expect(after?.content).toBe(original);
    expect(await chunkCount(before!.id)).toBe(chunksBefore);

    // And the same run succeeds once the failure is gone.
    await service.indexRepository(repo);
    const committed = await docByPath(path);
    expect(committed?.sha).not.toBe(before?.sha);
    expect(committed?.content).toContain('Added section');

    files.set(path, original);
    await service.indexRepository(repo);
  });
});
