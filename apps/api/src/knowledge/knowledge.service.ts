import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import {
  knowledgeChunks,
  knowledgeDocs,
  knowledgeHealth,
  repositories,
  type Db,
  type Repository,
} from '@specd/db';
import type { KnowledgeDocKind, RetrievedChunk } from '@specd/shared';
import { DB } from '../db/db.module.js';
import { DB_HANDLE } from '../db/db.module.js';
import type { DbHandle } from '@specd/db';
import { VcsService } from '../vcs/vcs.service.js';
import { EmbeddingService } from './embeddings.js';
import { chunkMarkdown, headingAnchor } from './chunker.js';

const KNOWLEDGE_PREFIX = 'knowledge/';
const STALE_AFTER_DAYS = 90;

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
        .select({ id: knowledgeDocs.id, sha: knowledgeDocs.sha })
        .from(knowledgeDocs)
        .where(
          and(eq(knowledgeDocs.repositoryId, repo.id), eq(knowledgeDocs.path, file.path)),
        )
        .limit(1);

      if (existing && existing.sha === sha) {
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
      indexed += 1;
      await log(`  indexed ${file.path}${hasUnverified ? ' (has UNVERIFIED markers)' : ''}`);
    }

    // Drop docs that no longer exist in git — the index is derived data and
    // must never outlive its source.
    const stored = await this.db
      .select({ id: knowledgeDocs.id, path: knowledgeDocs.path })
      .from(knowledgeDocs)
      .where(eq(knowledgeDocs.repositoryId, repo.id));

    let removed = 0;
    for (const doc of stored) {
      if (seen.has(doc.path)) continue;
      await this.db.delete(knowledgeDocs).where(eq(knowledgeDocs.id, doc.id));
      removed += 1;
    }

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
  ): Promise<RetrievedChunk[]> {
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
             f.vector_rank, f.text_rank, f.score
      FROM fused f
      JOIN knowledge_chunks c ON c.id = f.id
      JOIN knowledge_docs kd ON kd.id = c.doc_id
      JOIN repositories r ON r.id = kd.repository_id
      ORDER BY f.score DESC
      LIMIT ${limit}
    `;

    return rows.map((row) => ({
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
