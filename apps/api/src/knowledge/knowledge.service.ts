import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import {
  knowledgeChunks,
  knowledgeDocLinks,
  knowledgeDocs,
  knowledgeHealth,
  repositories,
  type Db,
  type Repository,
} from '@specd/db';
import type { KnowledgeDocKind, RetrievalResult, RetrievedChunk } from '@specd/shared';
import { DB } from '../db/db.module.js';
import { DB_HANDLE } from '../db/db.module.js';
import type { DbHandle } from '@specd/db';
import { VcsService } from '../vcs/vcs.service.js';
import { EmbeddingService } from './embeddings.js';
import { chunkMarkdown, headingAnchor } from './chunker.js';
import { extractLinks } from './link-extract.js';
import {
  headingAnchorsOf,
  resolvePathTarget,
  resolveWikiStem,
  type ResolvableDoc,
} from './link-resolve.js';

const KNOWLEDGE_PREFIX = 'knowledge/';
const STALE_AFTER_DAYS = 90;

/**
 * Bump when link-extraction rules change (S-102). A doc whose content sha is
 * unchanged but whose stamp is older re-extracts links only — no re-chunking,
 * no re-embedding — so extractor upgrades (and the feature's own arrival on
 * an already-indexed tree) propagate at one cheap pass per doc.
 *
 * v2: unresolved path references outside knowledge/ are no longer stored —
 * `docs/runners.md` in an ADR points at a real file, and calling it "broken"
 * was a false alarm the first live run surfaced.
 */
const LINKS_VERSION = 2;

/**
 * Shrink guard (S-102). A re-index that would remove most of a repo's docs is
 * far more likely to be a bad listing — wrong branch, revoked token, empty
 * response — than a real mass deletion, and committing it would gut the index
 * and every edge into it. Removing up to this many docs, or up to half, stays
 * normal maintenance; beyond both bounds the run fails loudly instead.
 */
const SHRINK_GUARD_MIN_REMOVALS = 4;

/** Edge-kind weights for expansion: an authored citation outranks a bare
 *  path mention. Tuned by rank only — the absolute values never mix with
 *  RRF scores. */
const EDGE_WEIGHT: Record<string, number> = {
  citation: 1.0,
  wikilink: 0.9,
  mdlink: 0.6,
  pathref: 0.4,
};

/** Expansion adds at most this many chunks; RRF picks are never displaced. */
const GRAPH_EXPANSION_BUDGET: number = 4;

/**
 * Docs with more resolved edges than this are hubs (READMEs, indexes).
 * Expansion never travels THROUGH a hub that was not itself a seed — the
 * "everything is one hop from the index page" blowup. A hub that IS a seed
 * is still expanded: being asked about is different from being adjacent.
 */
const HUB_DEGREE = 20;

@Injectable()
export class KnowledgeService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(DB_HANDLE) private readonly handle: DbHandle,
    private readonly vcs: VcsService,
    private readonly embeddings: EmbeddingService,
  ) {}

  /**
   * Re-index one repo's knowledge/ directory from git. Called on merge, on
   * demand, and nightly. Docs whose sha is unchanged are skipped, so the
   * common case costs a directory listing and nothing else.
   */
  async indexRepository(
    repo: Repository,
    log: (msg: string) => Promise<void> = async () => {},
  ): Promise<{ indexed: number; skipped: number; removed: number }> {
    const adapter = await this.vcs.adapterFor(repo);
    const target = this.vcs.toTarget(repo);

    const paths = (await adapter.listFiles(target, KNOWLEDGE_PREFIX)).filter((p) =>
      p.endsWith('.md'),
    );
    await log(`scanning ${repo.name}: ${paths.length} knowledge doc(s)`);

    const files = await adapter.readFiles(target, paths);
    const seen = new Set<string>();
    let indexed = 0;
    let skipped = 0;

    for (const file of files) {
      seen.add(file.path);
      const sha = createHash('sha256').update(file.content).digest('hex');

      const [existing] = await this.db
        .select({
          id: knowledgeDocs.id,
          sha: knowledgeDocs.sha,
          linksVersion: knowledgeDocs.linksVersion,
        })
        .from(knowledgeDocs)
        .where(
          and(eq(knowledgeDocs.repositoryId, repo.id), eq(knowledgeDocs.path, file.path)),
        )
        .limit(1);

      if (existing && existing.sha === sha) {
        if (existing.linksVersion !== LINKS_VERSION) {
          // Content unchanged, extractor newer (or the doc predates the graph
          // entirely): refresh links only. No re-chunk, no re-embed.
          await this.reindexLinks(existing.id, repo.projectId, file.path, file.content);
          await this.db
            .update(knowledgeDocs)
            .set({ linksVersion: LINKS_VERSION })
            .where(eq(knowledgeDocs.id, existing.id));
          await log(`  links refreshed for ${file.path}`);
        }
        skipped += 1;
        continue;
      }

      const docUpdatedAt =
        repo.provider === 'local'
          ? await this.vcs.localAdapter.lastCommitDate(target, file.path)
          : null;

      const kind = classify(file.path);
      const hasUnverified = /UNVERIFIED/.test(file.content);
      const isStub = /This is a generated stub/i.test(file.content);
      const title = firstHeading(file.content) ?? file.path;

      const docId = await this.upsertDoc({
        projectId: repo.projectId,
        repositoryId: repo.id,
        path: file.path,
        kind,
        title,
        sha,
        content: file.content,
        docUpdatedAt,
        hasUnverified,
        isStub,
        existingId: existing?.id,
      });

      await this.reindexChunks(docId, repo.projectId, file.content);
      await this.reindexLinks(docId, repo.projectId, file.path, file.content);
      indexed += 1;
      await log(`  indexed ${file.path}${hasUnverified ? ' (has UNVERIFIED markers)' : ''}`);
    }

    // Drop docs that no longer exist in git — the index is derived data and
    // must never outlive its source.
    const stored = await this.db
      .select({ id: knowledgeDocs.id, path: knowledgeDocs.path })
      .from(knowledgeDocs)
      .where(eq(knowledgeDocs.repositoryId, repo.id));

    const removals = stored.filter((doc) => !seen.has(doc.path));
    assertNoUnexplainedShrink(stored.length, removals.length, repo.name);

    let removed = 0;
    for (const doc of removals) {
      await this.db.delete(knowledgeDocs).where(eq(knowledgeDocs.id, doc.id));
      removed += 1;
    }

    // Re-resolution pass (S-102): a changed doc rewrote only its own outbound
    // edges, but the rest of the graph may point AT what changed — a link
    // whose target was just created resolves now, and a link whose target was
    // just deleted must fall back to unresolved (ON DELETE SET NULL left it
    // resolved-shaped with no target). One pass over this project's non-green
    // edges, resolving against the current doc set in SQL+memory, no
    // re-parsing of any unchanged doc.
    await this.reresolveLinks(repo.projectId);

    await this.db
      .update(repositories)
      .set({ lastIndexedAt: new Date(), kbStatus: paths.length > 0 ? 'indexed' : 'none' })
      .where(eq(repositories.id, repo.id));

    await this.recomputeHealth(repo.projectId);
    return { indexed, skipped, removed };
  }

  private async upsertDoc(input: {
    projectId: string;
    repositoryId: string;
    path: string;
    kind: KnowledgeDocKind;
    title: string;
    sha: string;
    content: string;
    docUpdatedAt: Date | null;
    hasUnverified: boolean;
    isStub: boolean;
    existingId?: string;
  }): Promise<string> {
    const values = {
      projectId: input.projectId,
      repositoryId: input.repositoryId,
      path: input.path,
      kind: input.kind,
      title: input.title,
      sha: input.sha,
      content: input.content,
      docUpdatedAt: input.docUpdatedAt,
      indexedAt: new Date(),
      hasUnverified: input.hasUnverified,
      isStub: input.isStub,
      linksVersion: LINKS_VERSION,
    };

    if (input.existingId) {
      await this.db.update(knowledgeDocs).set(values).where(eq(knowledgeDocs.id, input.existingId));
      return input.existingId;
    }

    const [row] = await this.db
      .insert(knowledgeDocs)
      .values(values)
      .returning({ id: knowledgeDocs.id });
    if (!row) throw new Error('failed to insert knowledge doc');
    return row.id;
  }

  private async reindexChunks(docId: string, projectId: string, content: string): Promise<void> {
    await this.db.delete(knowledgeChunks).where(eq(knowledgeChunks.docId, docId));

    const chunks = chunkMarkdown(content);
    if (chunks.length === 0) return;

    const vectors = await this.embeddings.embed(chunks.map((c) => `${c.heading ?? ''}\n${c.text}`));

    for (const [i, chunk] of chunks.entries()) {
      const vec = vectors[i];
      await this.handle.sql`
        INSERT INTO knowledge_chunks (doc_id, project_id, ord, heading, text, tokens, embedding)
        VALUES (
          ${docId}, ${projectId}, ${chunk.ord}, ${chunk.heading}, ${chunk.text}, ${chunk.tokens},
          ${vec ? EmbeddingService.toSqlVector(vec) : null}::vector
        )
      `;
    }
  }

  /**
   * Replace one doc's outbound edges from a fresh extraction (S-102).
   *
   * Scoped to the deterministic tier: a later LLM-derived tier coexists in
   * the same table and a re-extract of one must never wipe the other. Links
   * that do not resolve are kept as `unresolved` — flag, don't drop.
   */
  private async reindexLinks(
    docId: string,
    projectId: string,
    sourcePath: string,
    content: string,
  ): Promise<void> {
    await this.db
      .delete(knowledgeDocLinks)
      .where(
        and(
          eq(knowledgeDocLinks.sourceDocId, docId),
          eq(knowledgeDocLinks.originTier, 'deterministic'),
        ),
      );

    const extracted = extractLinks(content);
    if (extracted.length === 0) return;

    const docs: ResolvableDoc[] = await this.db
      .select({ id: knowledgeDocs.id, path: knowledgeDocs.path })
      .from(knowledgeDocs)
      .where(eq(knowledgeDocs.projectId, projectId));

    for (const link of extracted) {
      const resolved =
        link.kind === 'wikilink'
          ? resolveWikiStem(link.rawTarget, docs)
          : resolvePathTarget(link.rawTarget, sourcePath, docs);

      // The graph is scoped to knowledge docs. An unresolved path that never
      // claimed to be under knowledge/ is a reference to some other real file
      // (docs/runners.md, README.md) — out of scope, not broken. Reporting it
      // as "points at nothing" would be a false alarm, and a health signal
      // that cries wolf gets ignored. Wikilinks and knowledge/-rooted paths
      // stay: unresolved, those are genuinely broken.
      if (
        !resolved &&
        link.kind !== 'wikilink' &&
        !link.rawTarget.replace(/^\.\//, '').startsWith('knowledge/')
      ) {
        continue;
      }

      let state: 'resolved' | 'unresolved' | 'dangling_anchor' = resolved
        ? 'resolved'
        : 'unresolved';
      if (resolved && link.anchor) {
        const [target] = await this.db
          .select({ content: knowledgeDocs.content })
          .from(knowledgeDocs)
          .where(eq(knowledgeDocs.id, resolved.docId))
          .limit(1);
        if (target && !headingAnchorsOf(target.content).has(link.anchor)) {
          state = 'dangling_anchor';
        }
      }

      await this.db.insert(knowledgeDocLinks).values({
        projectId,
        sourceDocId: docId,
        kind: link.kind,
        site: link.site,
        rawTarget: link.rawTarget,
        resolvedDocId: state === 'unresolved' ? null : (resolved?.docId ?? null),
        resolvedAnchor: link.anchor,
        resolutionState: state,
      });
    }
  }

  /**
   * Bind the project's non-resolved edges against the current doc set, and
   * demote resolved-shaped edges whose target was deleted. O(links needing
   * attention) — nothing is re-parsed, which is what keeps incremental
   * indexing O(changed docs).
   */
  private async reresolveLinks(projectId: string): Promise<void> {
    // A deleted target leaves resolved rows with a NULLed doc id.
    await this.handle.sql`
      UPDATE knowledge_doc_links
      SET resolution_state = 'unresolved'
      WHERE project_id = ${projectId}
        AND resolution_state IN ('resolved', 'dangling_anchor')
        AND resolved_doc_id IS NULL
    `;

    const pending = await this.db
      .select({
        id: knowledgeDocLinks.id,
        kind: knowledgeDocLinks.kind,
        rawTarget: knowledgeDocLinks.rawTarget,
        anchor: knowledgeDocLinks.resolvedAnchor,
        sourceDocId: knowledgeDocLinks.sourceDocId,
      })
      .from(knowledgeDocLinks)
      .where(
        and(
          eq(knowledgeDocLinks.projectId, projectId),
          eq(knowledgeDocLinks.resolutionState, 'unresolved'),
        ),
      );
    if (pending.length === 0) return;

    const docs: ResolvableDoc[] = await this.db
      .select({ id: knowledgeDocs.id, path: knowledgeDocs.path })
      .from(knowledgeDocs)
      .where(eq(knowledgeDocs.projectId, projectId));
    const sourcePaths = new Map(docs.map((d) => [d.id, d.path]));

    for (const link of pending) {
      const resolved =
        link.kind === 'wikilink'
          ? resolveWikiStem(link.rawTarget, docs)
          : resolvePathTarget(link.rawTarget, sourcePaths.get(link.sourceDocId) ?? '', docs);
      if (!resolved) continue;

      let state: 'resolved' | 'dangling_anchor' = 'resolved';
      if (link.anchor) {
        const [target] = await this.db
          .select({ content: knowledgeDocs.content })
          .from(knowledgeDocs)
          .where(eq(knowledgeDocs.id, resolved.docId))
          .limit(1);
        if (target && !headingAnchorsOf(target.content).has(link.anchor)) {
          state = 'dangling_anchor';
        }
      }

      await this.db
        .update(knowledgeDocLinks)
        .set({ resolvedDocId: resolved.docId, resolutionState: state })
        .where(eq(knowledgeDocLinks.id, link.id));
    }
  }

  /**
   * Hybrid retrieval (§8 stage 2). Dense similarity and lexical rank are
   * fused with Reciprocal Rank Fusion: RRF needs only the *ordering* from each
   * side, so a weak embedder cannot drag down a strong lexical match, and
   * scores from two incomparable scales never have to be normalized against
   * each other.
   */
  async retrieve(
    projectId: string,
    query: string,
    limit = 12,
  ): Promise<RetrievalResult> {
    const queryVec = await this.embeddings.embedOne(query);
    const k = 60; // RRF damping — standard, keeps any single rank-1 from dominating.
    const pool = Math.max(limit * 4, 40);

    const rows = await this.handle.sql<
      {
        doc_id: string;
        repo_name: string;
        path: string;
        heading: string | null;
        text: string;
        vector_rank: number | null;
        text_rank: number | null;
        score: number;
        matched_total: number;
      }[]
    >`
      WITH dense AS (
        SELECT c.id,
               row_number() OVER (ORDER BY c.embedding <=> ${EmbeddingService.toSqlVector(queryVec)}::vector) AS rank
        FROM knowledge_chunks c
        WHERE c.project_id = ${projectId} AND c.embedding IS NOT NULL
        ORDER BY c.embedding <=> ${EmbeddingService.toSqlVector(queryVec)}::vector
        LIMIT ${pool}
      ),
      lexical AS (
        SELECT c.id,
               row_number() OVER (ORDER BY ts_rank_cd(c.tsv, plainto_tsquery('english', ${query})) DESC) AS rank
        FROM knowledge_chunks c
        WHERE c.project_id = ${projectId}
          AND c.tsv @@ plainto_tsquery('english', ${query})
        ORDER BY ts_rank_cd(c.tsv, plainto_tsquery('english', ${query})) DESC
        LIMIT ${pool}
      ),
      fused AS (
        SELECT COALESCE(d.id, l.id) AS id,
               d.rank AS vector_rank,
               l.rank AS text_rank,
               COALESCE(1.0 / (${k} + d.rank), 0) + COALESCE(1.0 / (${k} + l.rank), 0) AS score
        FROM dense d
        FULL OUTER JOIN lexical l ON l.id = d.id
      )
      SELECT c.doc_id, r.name AS repo_name, kd.path, c.heading, c.text,
             f.vector_rank, f.text_rank, f.score,
             (SELECT count(*) FROM fused)::int AS matched_total
      FROM fused f
      JOIN knowledge_chunks c ON c.id = f.id
      JOIN knowledge_docs kd ON kd.id = c.doc_id
      JOIN repositories r ON r.id = kd.repository_id
      ORDER BY f.score DESC
      LIMIT ${limit}
    `;

    const rrfChunks: RetrievedChunk[] = rows.map((row) => ({
      docId: row.doc_id,
      repoName: row.repo_name,
      path: row.path,
      heading: headingAnchor(row.heading),
      text: row.text,
      score: Number(row.score),
      via:
        row.vector_rank != null && row.text_rank != null
          ? 'both'
          : row.vector_rank != null
            ? 'vector'
            : 'fulltext',
    }));

    const matchedCount = Number(rows[0]?.matched_total ?? 0);

    // Stage 2 (S-102): one hop across the doc graph. The RRF picks above are
    // returned first, in their exact order — expansion only ever appends.
    const expansion = await this.expandViaGraph(projectId, query, queryVec, rrfChunks);

    return {
      chunks: [...rrfChunks, ...expansion],
      matchedCount,
      truncatedCount: Math.max(0, matchedCount - rrfChunks.length),
    };
  }

  /**
   * Graph expansion (S-102): the best chunk of each doc one resolved link
   * away from the seed docs, weighted by edge kind, hub-gated, budgeted.
   *
   * Every added chunk carries `via: 'graph'` and the edge that pulled it in,
   * so the run log can say WHY it arrived — an expanded chunk is citable
   * precisely because its provenance is checkable.
   */
  private async expandViaGraph(
    projectId: string,
    query: string,
    queryVec: number[],
    seeds: RetrievedChunk[],
  ): Promise<RetrievedChunk[]> {
    if (seeds.length === 0 || GRAPH_EXPANSION_BUDGET === 0) return [];

    const seedDocIds = [...new Set(seeds.map((c) => c.docId))];
    const seedRank = new Map(seedDocIds.map((id, i) => [id, i]));

    // Both directions: a doc the seed cites, and a doc that cites the seed.
    const edges = await this.handle.sql<
      {
        neighbor_id: string;
        neighbor_path: string;
        kind: string;
        seed_doc_id: string;
        source_path: string;
        site: string | null;
        degree: number;
      }[]
    >`
      WITH resolved AS (
        SELECT l.source_doc_id, l.resolved_doc_id, l.kind, l.site
        FROM knowledge_doc_links l
        WHERE l.project_id = ${projectId} AND l.resolution_state = 'resolved'
      ),
      degrees AS (
        SELECT doc_id, count(*)::int AS degree FROM (
          SELECT source_doc_id AS doc_id FROM resolved
          UNION ALL
          SELECT resolved_doc_id AS doc_id FROM resolved
        ) d GROUP BY doc_id
      ),
      hops AS (
        SELECT r.resolved_doc_id AS neighbor_id, r.kind, r.source_doc_id AS seed_doc_id, r.site
        FROM resolved r WHERE r.source_doc_id = ANY(${seedDocIds})
        UNION ALL
        SELECT r.source_doc_id AS neighbor_id, r.kind, r.resolved_doc_id AS seed_doc_id, r.site
        FROM resolved r WHERE r.resolved_doc_id = ANY(${seedDocIds})
      )
      SELECT h.neighbor_id, kd.path AS neighbor_path, h.kind, h.seed_doc_id,
             skd.path AS source_path, h.site,
             COALESCE(dg.degree, 0) AS degree
      FROM hops h
      JOIN knowledge_docs kd ON kd.id = h.neighbor_id
      JOIN knowledge_docs skd ON skd.id = h.seed_doc_id
      LEFT JOIN degrees dg ON dg.doc_id = h.neighbor_id
      WHERE h.neighbor_id <> ALL(${seedDocIds})
    `;
    if (edges.length === 0) return [];

    // Best edge per neighbor; hub-gate non-seed hubs; rank by edge weight,
    // then by how high the seed that led here ranked.
    const byNeighbor = new Map<
      string,
      { weight: number; seedOrd: number; edgeLabel: string }
    >();
    for (const edge of edges) {
      if (edge.degree > HUB_DEGREE) continue;
      const weight = EDGE_WEIGHT[edge.kind] ?? 0.3;
      const seedOrd = seedRank.get(edge.seed_doc_id) ?? seedDocIds.length;
      const label = `${edge.kind} ${edge.site ? `at ${edge.source_path}#${edge.site}` : `from ${edge.source_path}`}`;
      const current = byNeighbor.get(edge.neighbor_id);
      if (!current || weight > current.weight || (weight === current.weight && seedOrd < current.seedOrd)) {
        byNeighbor.set(edge.neighbor_id, { weight, seedOrd, edgeLabel: label });
      }
    }
    if (byNeighbor.size === 0) return [];

    const ranked = [...byNeighbor.entries()]
      .sort((a, b) => b[1].weight - a[1].weight || a[1].seedOrd - b[1].seedOrd)
      .slice(0, GRAPH_EXPANSION_BUDGET)
      .map(([docId]) => docId);

    // Best chunk per neighbor doc for THIS query — same two arms, restricted
    // to the neighbor docs, one row per doc.
    const chunks = await this.handle.sql<
      {
        doc_id: string;
        repo_name: string;
        path: string;
        heading: string | null;
        text: string;
      }[]
    >`
      SELECT DISTINCT ON (c.doc_id)
             c.doc_id, r.name AS repo_name, kd.path, c.heading, c.text
      FROM knowledge_chunks c
      JOIN knowledge_docs kd ON kd.id = c.doc_id
      JOIN repositories r ON r.id = kd.repository_id
      WHERE c.doc_id = ANY(${ranked})
      ORDER BY c.doc_id,
               (CASE WHEN c.tsv @@ plainto_tsquery('english', ${query})
                     THEN ts_rank_cd(c.tsv, plainto_tsquery('english', ${query})) ELSE 0 END) DESC,
               (c.embedding <=> ${EmbeddingService.toSqlVector(queryVec)}::vector) ASC
    `;

    const order = new Map(ranked.map((id, i) => [id, i]));
    return chunks
      .sort((a, b) => (order.get(a.doc_id) ?? 99) - (order.get(b.doc_id) ?? 99))
      .map((row) => ({
        docId: row.doc_id,
        repoName: row.repo_name,
        path: row.path,
        heading: headingAnchor(row.heading),
        text: row.text,
        score: 0,
        via: 'graph' as const,
        viaEdge: byNeighbor.get(row.doc_id)?.edgeLabel,
      }));
  }

  async listDocs(projectId: string, repositoryId?: string) {
    const where = repositoryId
      ? and(eq(knowledgeDocs.projectId, projectId), eq(knowledgeDocs.repositoryId, repositoryId))
      : eq(knowledgeDocs.projectId, projectId);

    const rows = await this.db
      .select({
        id: knowledgeDocs.id,
        path: knowledgeDocs.path,
        kind: knowledgeDocs.kind,
        title: knowledgeDocs.title,
        docUpdatedAt: knowledgeDocs.docUpdatedAt,
        indexedAt: knowledgeDocs.indexedAt,
        hasUnverified: knowledgeDocs.hasUnverified,
        isStub: knowledgeDocs.isStub,
        repositoryId: knowledgeDocs.repositoryId,
      })
      .from(knowledgeDocs)
      .where(where)
      .orderBy(knowledgeDocs.path);

    return rows.map((row) => ({
      ...row,
      freshness: freshnessOf(row.docUpdatedAt ?? row.indexedAt, row.isStub),
    }));
  }

  async getDoc(projectId: string, docId: string) {
    const [row] = await this.db
      .select()
      .from(knowledgeDocs)
      .where(and(eq(knowledgeDocs.id, docId), eq(knowledgeDocs.projectId, projectId)))
      .limit(1);
    return row ?? null;
  }

  /**
   * A doc's outbound links and inbound backlinks (S-102), for the doc view.
   * Unresolved outbound links are included on purpose: they are the broken
   * ones a maintainer needs to see.
   */
  async docLinks(projectId: string, docId: string) {
    const outbound = await this.handle.sql<
      { kind: string; raw_target: string; site: string | null; state: string; target_path: string | null }[]
    >`
      SELECT l.kind, l.raw_target, l.site, l.resolution_state AS state, kd.path AS target_path
      FROM knowledge_doc_links l
      LEFT JOIN knowledge_docs kd ON kd.id = l.resolved_doc_id
      WHERE l.project_id = ${projectId} AND l.source_doc_id = ${docId}
      ORDER BY l.kind, l.raw_target
    `;
    const inbound = await this.handle.sql<
      { kind: string; site: string | null; source_path: string; source_doc_id: string }[]
    >`
      SELECT l.kind, l.site, kd.path AS source_path, l.source_doc_id
      FROM knowledge_doc_links l
      JOIN knowledge_docs kd ON kd.id = l.source_doc_id
      WHERE l.project_id = ${projectId}
        AND l.resolved_doc_id = ${docId}
        AND l.resolution_state = 'resolved'
      ORDER BY kd.path
    `;

    return {
      outbound: outbound.map((l) => ({
        kind: l.kind,
        rawTarget: l.raw_target,
        site: l.site,
        state: l.state,
        targetPath: l.target_path,
      })),
      backlinks: inbound.map((l) => ({
        kind: l.kind,
        site: l.site,
        sourcePath: l.source_path,
        sourceDocId: l.source_doc_id,
      })),
    };
  }

  /**
   * Knowledge health — the number that makes doc rot as visible as CI status
   * (§P6). Deliberately simple and explainable: a score nobody can reason
   * about gets ignored.
   */
  async recomputeHealth(projectId: string): Promise<void> {
    const docs = await this.db
      .select({
        docUpdatedAt: knowledgeDocs.docUpdatedAt,
        indexedAt: knowledgeDocs.indexedAt,
        isStub: knowledgeDocs.isStub,
        hasUnverified: knowledgeDocs.hasUnverified,
        kind: knowledgeDocs.kind,
        path: knowledgeDocs.path,
      })
      .from(knowledgeDocs)
      .where(eq(knowledgeDocs.projectId, projectId));

    const docCount = docs.length;
    const asBuiltCount = docs.filter((d) => d.kind === 'spec').length;
    const stubs = docs.filter((d) => d.isStub);
    const stale = docs.filter(
      (d) => freshnessOf(d.docUpdatedAt ?? d.indexedAt, d.isStub).stale && !d.isStub,
    );
    const unverified = docs.filter((d) => d.hasUnverified);

    // Graph health (S-102): links that point nowhere, anchors that no longer
    // exist, and docs nothing links to. Cheap SQL over the links table.
    const [graph] = await this.handle.sql<
      { broken: number; dangling: number; orphans: number }[]
    >`
      SELECT
        (SELECT count(*) FROM knowledge_doc_links
          WHERE project_id = ${projectId} AND resolution_state = 'unresolved')::int AS broken,
        (SELECT count(*) FROM knowledge_doc_links
          WHERE project_id = ${projectId} AND resolution_state = 'dangling_anchor')::int AS dangling,
        (SELECT count(*) FROM knowledge_docs kd
          WHERE kd.project_id = ${projectId}
            AND NOT EXISTS (
              SELECT 1 FROM knowledge_doc_links l
              WHERE l.project_id = ${projectId}
                AND l.resolved_doc_id = kd.id
                AND l.resolution_state = 'resolved'
            ))::int AS orphans
    `;
    const brokenLinks = Number(graph?.broken ?? 0);
    const danglingAnchors = Number(graph?.dangling ?? 0);
    const orphanDocs = Number(graph?.orphans ?? 0);

    let score = 100;
    if (docCount === 0) {
      score = 0;
    } else {
      score -= (stale.length / docCount) * 40;
      score -= (stubs.length / docCount) * 25;
      score -= (unverified.length / docCount) * 20;
      // Never fully penalise a young knowledge base for having no history yet.
      score = Math.max(0, Math.min(100, score));
    }

    const notes: { icon: string; text: string }[] = [];
    for (const doc of stale.slice(0, 3)) {
      const days = Math.floor(
        (Date.now() - (doc.docUpdatedAt ?? doc.indexedAt).getTime()) / 86_400_000,
      );
      notes.push({
        icon: '⚠',
        text: `${doc.path} untouched for ${days} days — likely drifted from the code.`,
      });
    }
    if (asBuiltCount > 0) {
      notes.push({
        icon: '📗',
        text: `${asBuiltCount} as-built spec${asBuiltCount === 1 ? '' : 's'} filed — the loop is closing.`,
      });
    }
    for (const stub of stubs.slice(0, 2)) {
      notes.push({ icon: '💡', text: `${stub.path} is still the generated stub — assign an owner.` });
    }
    if (unverified.length > 0) {
      notes.push({
        icon: '🔎',
        text: `${unverified.length} doc${unverified.length === 1 ? '' : 's'} still carry UNVERIFIED markers.`,
      });
    }
    if (brokenLinks > 0) {
      notes.push({
        icon: '🔗',
        text: `${brokenLinks} link${brokenLinks === 1 ? '' : 's'} point at nothing — a rename or deletion nobody chased.`,
      });
    }
    if (danglingAnchors > 0) {
      notes.push({
        icon: '⚓',
        text: `${danglingAnchors} citation anchor${danglingAnchors === 1 ? '' : 's'} no longer exist in their target doc.`,
      });
    }
    if (docCount > 3 && orphanDocs > 0) {
      notes.push({
        icon: '🏝',
        text: `${orphanDocs} doc${orphanDocs === 1 ? ' is' : 's are'} linked from nowhere — knowledge nobody will find by following anything.`,
      });
    }

    await this.handle.sql`
      INSERT INTO knowledge_health (project_id, score, doc_count, stale_count, stub_count, as_built_count, notes, computed_at)
      VALUES (${projectId}, ${score}, ${docCount}, ${stale.length}, ${stubs.length}, ${asBuiltCount},
              ${JSON.stringify(notes)}::jsonb, now())
      ON CONFLICT (project_id) DO UPDATE SET
        score = EXCLUDED.score,
        doc_count = EXCLUDED.doc_count,
        stale_count = EXCLUDED.stale_count,
        stub_count = EXCLUDED.stub_count,
        as_built_count = EXCLUDED.as_built_count,
        notes = EXCLUDED.notes,
        computed_at = now()
    `;
  }

  async health(projectId: string) {
    const [row] = await this.db
      .select()
      .from(knowledgeHealth)
      .where(eq(knowledgeHealth.projectId, projectId))
      .limit(1);

    return (
      row ?? {
        projectId,
        score: 0,
        docCount: 0,
        staleCount: 0,
        stubCount: 0,
        asBuiltCount: 0,
        notes: [],
        computedAt: new Date(),
      }
    );
  }

  /** Grounding quality over recent specs (§P6 "Grounding quality" panel). */
  async groundingQuality(projectId: string): Promise<{ avgCitations: number; avgUnverified: number; sample: number }> {
    const [row] = await this.handle.sql<
      { avg_citations: number | null; avg_unverified: number | null; n: number }[]
    >`
      SELECT avg(citation_count)::float AS avg_citations,
             avg(unverified_count)::float AS avg_unverified,
             count(*)::int AS n
      FROM (
        SELECT citation_count, unverified_count
        FROM specs
        WHERE project_id = ${projectId}
        ORDER BY created_at DESC
        LIMIT 10
      ) recent
    `;

    return {
      avgCitations: Number(row?.avg_citations ?? 0),
      avgUnverified: Number(row?.avg_unverified ?? 0),
      sample: Number(row?.n ?? 0),
    };
  }
}

/**
 * Refuse a re-index that would silently gut the repo's slice of the index.
 *
 * Exported for direct testing. Removing a handful of docs is normal
 * maintenance; removing most of them at once is almost always a bad listing
 * (wrong branch, revoked token, empty response), and committing it destroys
 * every edge into those docs too. The error says exactly how to proceed when
 * the mass deletion is real.
 */
export function assertNoUnexplainedShrink(
  storedCount: number,
  removalCount: number,
  repoName: string,
): void {
  if (removalCount < SHRINK_GUARD_MIN_REMOVALS) return;
  if (removalCount * 2 <= storedCount) return;

  throw new Error(
    `Refusing to re-index ${repoName}: this run would remove ${removalCount} of ` +
      `${storedCount} indexed knowledge doc(s). That usually means the listing was ` +
      `wrong (branch, token, network), not that the docs are gone. If the deletion ` +
      `is real, remove and re-add the repository — or delete the docs in smaller ` +
      `batches — and the index will follow.`,
  );
}

function classify(path: string): KnowledgeDocKind {
  if (path.includes('/specs/')) return 'spec';
  if (path.includes('/decisions/')) return 'adr';
  if (path.includes('/runbooks/')) return 'runbook';
  return 'doc';
}

function firstHeading(content: string): string | null {
  const match = /^#\s+(.+)$/m.exec(content);
  return match?.[1]?.trim() ?? null;
}

function freshnessOf(updatedAt: Date, isStub: boolean) {
  const ageDays = Math.floor((Date.now() - updatedAt.getTime()) / 86_400_000);
  const stale = ageDays > STALE_AFTER_DAYS;
  return {
    score: Math.max(0, 100 - (ageDays / STALE_AFTER_DAYS) * 100),
    ageDays,
    stale,
    reason: isStub ? 'generated stub, never filled in' : stale ? `${ageDays}d since last change` : undefined,
  };
}
