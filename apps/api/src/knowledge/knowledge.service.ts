import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';
import {
  codeNodes,
  knowledgeChunks,
  knowledgeDocCoupling,
  knowledgeDocLinks,
  knowledgeDocs,
  knowledgeHealth,
  repoCommits,
  repositories,
  type Db,
  type DbContext,
  type Repository,
} from '@specd/db';
import type {
  CitationCoverage,
  KnowledgeDocKind,
  RetrievalResult,
  RetrievedChunk,
} from '@specd/shared';
import { DB } from '../db/db.module.js';
import { DB_HANDLE } from '../db/db.module.js';
import type { DbHandle } from '@specd/db';
import { VcsService } from '../vcs/vcs.service.js';
import { EmbeddingService } from './embeddings.js';
import { CHUNKER_VERSION, chunkMarkdown, headingAnchor } from './chunker.js';
import { extractLinks } from './link-extract.js';
import { couplingFrom, type HistoryCommit } from './history.js';
import { SYMBOL_EXTENSIONS, extractSymbols, specForPath } from './symbols.js';
import {
  EDGE_WEIGHT,
  LINK_KINDS,
  ORIGIN_TIERS,
  RESOLUTION_STATES,
  type LinkKind,
} from './graph-schema.js';
import {
  headingAnchorsOf,
  resolveCodeTarget,
  resolvePathTarget,
  resolveWikiStem,
  type ResolvableCode,
  type ResolvableDoc,
} from './link-resolve.js';

const KNOWLEDGE_PREFIX = 'knowledge/';
const STALE_AFTER_DAYS = 90;
/**
 * Code commits since a doc last changed before it counts as drifted. Some
 * churn beneath a doc is normal; this many says the ground moved.
 */
const DRIFT_COMMITS = 10;

/**
 * History window for coupling (0013). Twelve months, not "all": a long-lived
 * repository's early commits describe an architecture that no longer exists,
 * and coupling to a deleted module outvotes the truth.
 */
const COUPLING_WINDOW_DAYS = 365;
/** Coupled areas kept per doc. Beyond a handful it stops being a signal. */
const COUPLING_PER_DOC = 5;

/**
 * Files parsed for symbols per run. Symbol extraction is demand-driven — only
 * files the docs actually reference — so this cap is a backstop rather than
 * the usual limit, and the run log says when it bites. Reading every source
 * file would mean one HTTP GET per file on a hosted repo.
 */
const SYMBOL_FILE_CAP = 200;

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

/** One doc's worth of work, prepared before the transaction opens. */
interface PreparedDoc {
  path: string;
  content: string;
  sha: string;
  kind: KnowledgeDocKind;
  title: string;
  hasUnverified: boolean;
  isStub: boolean;
  docUpdatedAt: Date | null;
  existingId: string | undefined;
  chunks: ReturnType<typeof chunkMarkdown>;
  vectors: (number[] | undefined)[];
  /** Assigned inside the transaction, once the row exists. */
  docId?: string;
}

/** Resolves a doc's heading anchors once per run, not once per link. */
type AnchorLookup = (docId: string) => Promise<Set<string>>;

/** Expansion adds at most this many chunks; RRF picks are never displaced. */
const GRAPH_EXPANSION_BUDGET: number = 4;

/**
 * An expanded chunk scores its seed's score, discounted by the edge kind and
 * again by this, because a neighbour is evidence about the query only at one
 * remove. Zero was the old value: correct in ordering — expansion is appended
 * and never displaces an RRF pick — but it threw away which expansions were
 * strong, so nothing downstream could rank, threshold or explain them.
 */
const GRAPH_SCORE_DISCOUNT = 0.5;

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
   * What currently turns a doc into rows: the chunking rules and the embedder
   * behind them. Stamped on every doc the indexer writes and compared on the
   * next run, so changing either re-indexes docs whose source never moved —
   * the case a content hash alone cannot see.
   */
  private indexFingerprint(): string {
    return `chunk=${CHUNKER_VERSION};embed=${this.embeddings.fingerprint}`;
  }

  /**
   * Re-index one repo's knowledge/ directory from git. Called on merge and on
   * demand. Docs whose sha is unchanged are skipped, so the common case costs
   * a directory listing and nothing else.
   *
   * Two phases, deliberately. Everything slow and fallible — the VCS listing,
   * the file reads, the embedding call — happens first, outside any
   * transaction, because a transaction held open across a network round trip
   * is a lock held across a network round trip. Then every write lands in one
   * transaction: either the whole run is visible or none of it is. Before that
   * transaction can commit, two guards have to agree that what it is about to
   * throw away was actually meant to go.
   */
  async indexRepository(
    repo: Repository,
    log: (msg: string) => Promise<void> = async () => {},
  ): Promise<{ indexed: number; skipped: number; removed: number }> {
    const adapter = await this.vcs.adapterFor(repo);
    const target = this.vcs.toTarget(repo);

    // One listing for both halves of the index. For a hosted repo this is a
    // recursive tree call, so asking twice would double the cost of every run.
    const listing = await adapter.listFilesWithSha(target, '');
    const paths = listing
      .map((f) => f.path)
      .filter((p) => p.startsWith(KNOWLEDGE_PREFIX) && p.endsWith('.md'));
    const codeFiles = listing.filter((f) => !f.path.startsWith(KNOWLEDGE_PREFIX));
    const codePaths = codeFiles.map((f) => f.path);
    const shaByPath = new Map(codeFiles.map((f) => [f.path, f.sha]));
    await log(
      `scanning ${repo.name}: ${paths.length} knowledge doc(s), ${codePaths.length} code file(s)`,
    );

    const files = await adapter.readFiles(target, paths);

    // --- Prepare (no writes, no transaction) -----------------------------
    const stored = await this.db
      .select({
        id: knowledgeDocs.id,
        path: knowledgeDocs.path,
        sha: knowledgeDocs.sha,
        linksVersion: knowledgeDocs.linksVersion,
        indexFingerprint: knowledgeDocs.indexFingerprint,
      })
      .from(knowledgeDocs)
      .where(eq(knowledgeDocs.repositoryId, repo.id));
    const storedByPath = new Map(stored.map((doc) => [doc.path, doc]));

    // What would build this doc's chunks today. A sha match only means the
    // source is unchanged; it says nothing about whether the chunker and
    // embedder that produced the stored rows are still the ones in use.
    const fingerprint = this.indexFingerprint();

    const seen = new Set<string>();
    const changed: PreparedDoc[] = [];
    const relink: { docId: string; path: string; content: string }[] = [];
    let skipped = 0;
    let restamped = 0;

    for (const file of files) {
      seen.add(file.path);
      const sha = createHash('sha256').update(file.content).digest('hex');
      const existing = storedByPath.get(file.path);

      if (existing && existing.sha === sha && existing.indexFingerprint !== fingerprint) {
        restamped += 1;
      }

      if (existing && existing.sha === sha && existing.indexFingerprint === fingerprint) {
        if (existing.linksVersion !== LINKS_VERSION) {
          // Content unchanged, extractor newer (or the doc predates the graph
          // entirely): refresh links only. No re-chunk, no re-embed.
          relink.push({ docId: existing.id, path: file.path, content: file.content });
        }
        skipped += 1;
        continue;
      }

      changed.push({
        path: file.path,
        content: file.content,
        sha,
        kind: classify(file.path),
        title: firstHeading(file.content) ?? file.path,
        hasUnverified: /UNVERIFIED/.test(file.content),
        isStub: /This is a generated stub/i.test(file.content),
        docUpdatedAt:
          repo.provider === 'local'
            ? await this.vcs.localAdapter.lastCommitDate(target, file.path)
            : null,
        existingId: existing?.id,
        chunks: chunkMarkdown(file.content),
        vectors: [],
      });
    }

    // One embedding call for the whole run. Per-doc calls meant one HTTP round
    // trip per doc against a provider that batches anyway.
    const texts = changed.flatMap((doc) =>
      doc.chunks.map((chunk) => `${chunk.heading ?? ''}\n${chunk.text}`),
    );
    if (texts.length > 0) {
      const vectors = await this.embeddings.embed(texts);
      let at = 0;
      for (const doc of changed) {
        doc.vectors = vectors.slice(at, at + doc.chunks.length);
        at += doc.chunks.length;
      }
    }

    // Symbols, for the files the docs point at. Reading happens here, outside
    // the transaction, because on a hosted repo it is one HTTP GET per file.
    const referenced = new Set<string>();
    for (const doc of [...changed, ...relink]) {
      for (const link of extractLinks(doc.content)) {
        if (link.kind === 'coderef') referenced.add(link.rawTarget);
      }
    }
    // Docs that did not change this run still reference code; their edges are
    // already stored, so ask the table rather than re-reading every doc.
    const storedRefs = await this.handle.sql<{ raw_target: string }[]>`
      SELECT DISTINCT l.raw_target
      FROM knowledge_doc_links l
      JOIN knowledge_docs kd ON kd.id = l.source_doc_id
      WHERE kd.repository_id = ${repo.id} AND l.kind = 'coderef'
    `;
    for (const row of storedRefs) referenced.add(row.raw_target);

    const codeSet = new Set(codePaths);
    const parseable = [...referenced]
      .map((raw) => {
        const cleaned = raw.replace(/^\.\//, '');
        if (codeSet.has(cleaned)) return cleaned;
        const suffix = codePaths.filter((p) => p.endsWith(`/${cleaned}`));
        return suffix.length === 1 ? suffix[0]! : null;
      })
      .filter((p): p is string => p !== null && specForPath(p) !== null);

    // Referenced files first, then the rest of the tree. Parsing only what the
    // docs already name resolved 2 of 18 symbol references on this repository:
    // most symbols live in files a doc discusses without spelling out a path.
    // Ordering by reference means the cap, when it bites, drops the files
    // least likely to be cited rather than an arbitrary slice.
    const priority = new Set(parseable);
    const candidates = [
      ...parseable,
      ...codePaths.filter((p) => !priority.has(p) && specForPath(p) !== null),
    ];
    // What we parsed last time, and what it looked like. A file whose blob is
    // unchanged has the same declarations it had before, so re-reading it is
    // one HTTP GET spent to learn nothing — the whole reason the sha is here.
    const parsedBefore = new Map(
      (
        await this.handle.sql<{ path: string; blob_sha: string | null }[]>`
          SELECT DISTINCT path, blob_sha FROM code_nodes
          WHERE repository_id = ${repo.id} AND kind <> 'file'
        `
      ).map((r) => [r.path, r.blob_sha]),
    );

    const eligible = [...new Set(candidates)].slice(0, SYMBOL_FILE_CAP);
    const toParse = eligible.filter((p) => parsedBefore.get(p) !== shaByPath.get(p));
    const unchangedParsed = eligible.filter((p) => !toParse.includes(p));
    if (toParse.length < eligible.length) {
      await log(
        `  symbols: ${toParse.length} file(s) changed, ${eligible.length - toParse.length} unchanged`,
      );
    }
    if (candidates.length > toParse.length) {
      // No silent truncation: a symbol that resolves for one doc and not
      // another because of an invisible cap is worse than no symbols.
      await log(
        `  symbol extraction capped at ${SYMBOL_FILE_CAP} file(s); ` +
          `${new Set(candidates).size - eligible.length} source file(s) not parsed`,
      );
    }

    const symbolRows: { path: string; qualifiedName: string; kind: string; line: number }[] = [];
    if (toParse.length > 0) {
      const sources = await adapter.readFiles(target, toParse).catch(() => []);
      for (const file of sources) {
        for (const sym of extractSymbols(file.path, file.content)) {
          symbolRows.push({
            path: file.path,
            qualifiedName: sym.qualifiedName,
            kind: sym.kind,
            line: sym.line,
          });
        }
      }
    }

    if (restamped > 0) {
      await log(
        `  ${restamped} unchanged doc(s) re-embedded: chunker/embedder is now ${fingerprint}`,
      );
    }

    // Docs that no longer exist in git — the index is derived data and must
    // never outlive its source.
    const removals = stored.filter((doc) => !seen.has(doc.path));

    // --- Commit (one transaction, guarded) -------------------------------
    await this.handle.transaction(async (tx) => {
      assertNoUnexplainedShrink(stored.length, removals.length, paths.length, repo.name);

      const edgesBefore = await edgeCountsBySource(tx, repo.projectId);
      /** Docs this run is entitled to remove rows from. */
      const touched = new Set<string>();

      for (const doc of changed) {
        doc.docId = await upsertDoc(tx, repo, doc, fingerprint);
        touched.add(doc.docId);
      }

      for (const doc of removals) {
        await tx.db.delete(knowledgeDocs).where(eq(knowledgeDocs.id, doc.id));
        touched.add(doc.id);
      }

      // The file tree a doc can point at. Replaced wholesale: it is derived
      // from one listing of one commit, and a stale row would let a deleted
      // file keep answering for references to it.
      // Upserted, not replaced. A file node's id is what a doc's link points
      // at, so deleting and reinserting the inventory would null every link
      // from a doc that did not change this run — and because it did not
      // change, nothing would ever put it back.
      if (codePaths.length > 0) {
        await tx.sql`
          INSERT INTO code_nodes (project_id, repository_id, kind, path, qualified_name, blob_sha)
          SELECT ${repo.projectId}, ${repo.id}, 'file', p, p, s
          FROM unnest(${codePaths}::text[], ${codePaths.map((p) => shaByPath.get(p) ?? '')}::text[]) AS t(p, s)
          ON CONFLICT (repository_id, kind, qualified_name)
          DO UPDATE SET blob_sha = EXCLUDED.blob_sha, indexed_at = now()
        `;
      }
      await tx.sql`
        DELETE FROM code_nodes
        WHERE repository_id = ${repo.id} AND kind = 'file'
          AND qualified_name <> ALL(${codePaths})
      `;
      // Symbols go only for files we re-read, or whose file is gone. The rest
      // are still accurate: their blob did not move.
      await tx.sql`
        DELETE FROM code_nodes
        WHERE repository_id = ${repo.id} AND kind <> 'file'
          AND (path = ANY(${toParse}) OR path <> ALL(${codePaths}))
      `;
      // Symbols share the table with files; a duplicate qualified name across
      // two parsed files is dropped rather than resolved arbitrarily, which is
      // the same rule the path resolver uses for ambiguous basenames.
      void unchangedParsed;
      const bySymbol = new Map<string, { path: string; kind: string; line: number }>();
      const ambiguous = new Set<string>();
      for (const row of symbolRows) {
        if (bySymbol.has(row.qualifiedName)) ambiguous.add(row.qualifiedName);
        else bySymbol.set(row.qualifiedName, row);
      }
      for (const name of ambiguous) bySymbol.delete(name);

      if (bySymbol.size > 0) {
        const names = [...bySymbol.keys()];
        await tx.sql`
          INSERT INTO code_nodes (project_id, repository_id, kind, path, qualified_name, start_line, blob_sha)
          SELECT ${repo.projectId}, ${repo.id}, k, p, q, l, b
          FROM unnest(
            ${names.map((n) => bySymbol.get(n)!.kind)}::text[],
            ${names.map((n) => bySymbol.get(n)!.path)}::text[],
            ${names}::text[],
            ${names.map((n) => bySymbol.get(n)!.line)}::int[],
            ${names.map((n) => shaByPath.get(bySymbol.get(n)!.path) ?? '')}::text[]
          ) AS t(k, p, q, l, b)
          ON CONFLICT (repository_id, kind, qualified_name) DO NOTHING
        `;
      }

      const code: ResolvableCode[] = await tx.db
        .select({ id: codeNodes.id, path: codeNodes.path })
        .from(codeNodes)
        .where(and(eq(codeNodes.repositoryId, repo.id), eq(codeNodes.kind, 'file')));

      const symbolRowsStored = await tx.db
        .select({ id: codeNodes.id, qualifiedName: codeNodes.qualifiedName })
        .from(codeNodes)
        .where(and(eq(codeNodes.repositoryId, repo.id), ne(codeNodes.kind, 'file')));
      const symbols = new Map(symbolRowsStored.map((r) => [r.qualifiedName, r.id]));
      // Container names, so `Config.redisUrl` can be told from `Foo.bar`: if
      // the parent is a declaration we indexed and the member is not, the
      // member was ours and is gone. That is a finding. If the parent is
      // unknown too, the whole thing was never ours and is silence.
      const symbolParents = new Set(
        symbolRowsStored.map((r) => r.qualifiedName.split('.')[0]!),
      );
      // First segment of every path in the repo. A coderef whose first segment
      // is not one of these was never ours — a Go module path, an npm
      // specifier — and calling it broken is the false alarm S-102's v2
      // deviation was written to stop.
      const ownTopLevel = new Set(codePaths.map((p) => p.split('/')[0]!));

      // The doc set is final now, so every link in this run resolves against
      // one snapshot of it — the previous code re-read the whole project's doc
      // list once per doc.
      const docs: ResolvableDoc[] = await tx.db
        .select({ id: knowledgeDocs.id, path: knowledgeDocs.path })
        .from(knowledgeDocs)
        .where(eq(knowledgeDocs.projectId, repo.projectId));
      const anchors = anchorLookup(tx);

      const scope = { code, ownTopLevel, symbols, symbolParents, shaByPath };
      for (const doc of changed) {
        await writeChunks(tx, doc.docId!, repo.projectId, doc);
        await writeLinks(
          tx, doc.docId!, repo.projectId, doc.path, doc.content, docs, anchors, scope, doc.kind,
        );
      }

      for (const doc of relink) {
        await writeLinks(
          tx, doc.docId, repo.projectId, doc.path, doc.content, docs, anchors, scope,
          classify(doc.path),
        );
        await tx.db
          .update(knowledgeDocs)
          .set({ linksVersion: LINKS_VERSION })
          .where(eq(knowledgeDocs.id, doc.docId));
        touched.add(doc.docId);
      }

      // Re-resolution pass (S-102): a changed doc rewrote only its own outbound
      // edges, but the rest of the graph may point AT what changed — a link
      // whose target was just created resolves now, and a link whose target was
      // just deleted must fall back to unresolved (ON DELETE SET NULL left it
      // resolved-shaped with no target). Nothing is re-parsed.
      await this.reresolveLinks(tx, repo.projectId, docs, anchors);

      await assertNoUnexplainedEdgeLoss(tx, repo.projectId, edgesBefore, touched, repo.name);

      await tx.db
        .update(repositories)
        .set({ lastIndexedAt: new Date(), kbStatus: paths.length > 0 ? 'indexed' : 'none' })
        .where(eq(repositories.id, repo.id));

      await this.recomputeHealth(repo.projectId, tx);
    });

    // Drift, from whatever history is available: `git log` for a repo with a
    // working tree, the webhook-fed ledger for one specd cannot clone. Where
    // neither has anything yet, nothing is written and freshness keeps saying
    // "unmeasured" rather than inventing a number. `commitsSince` was written as
    // the drift signal when the index was built and then never called, so the
    // "flags docs that have drifted from the code" claim in knowledge/README.md
    // has until now been backed by a 90-day timer — the calendar, not the
    // codebase. This is the real thing, and it stays null where the provider
    // gives us no commit dates rather than pretending to a measurement.
    await this.refreshDrift(repo, target);

    // Logged after the commit: until it lands, none of this happened.
    for (const doc of relink) await log(`  links refreshed for ${doc.path}`);
    for (const doc of changed) {
      await log(`  indexed ${doc.path}${doc.hasUnverified ? ' (has UNVERIFIED markers)' : ''}`);
    }

    return { indexed: changed.length, skipped, removed: removals.length };
  }

  /**
   * Bind the project's non-resolved edges against the current doc set, and
   * demote resolved-shaped edges whose target was deleted. O(links needing
   * attention) — nothing is re-parsed, which is what keeps incremental
   * indexing O(changed docs).
   */
  private async reresolveLinks(
    tx: DbContext,
    projectId: string,
    docs: ResolvableDoc[],
    anchors: AnchorLookup,
  ): Promise<void> {
    // A deleted target leaves resolved rows with a NULLed id. Either id: a
    // coderef points at a code node instead of a doc, so demoting on a null
    // doc id alone would demote every one of them — and checking both is also
    // what catches a doc whose source file was deleted.
    await tx.sql`
      UPDATE knowledge_doc_links
      SET resolution_state = 'unresolved'
      WHERE project_id = ${projectId}
        AND resolution_state IN ('resolved', 'dangling_anchor')
        AND resolved_doc_id IS NULL
        AND resolved_code_id IS NULL
    `;

    const pending = await tx.db
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
          // A coderef resolves against the file tree, which the index pass has
          // just rewritten; re-resolving it here against docs would only ever
          // fail and would overwrite a correct verdict.
          ne(knowledgeDocLinks.kind, 'coderef'),
          ne(knowledgeDocLinks.kind, 'symbolref'),
        ),
      );
    if (pending.length === 0) return;

    const sourcePaths = new Map(docs.map((d) => [d.id, d.path]));

    for (const link of pending) {
      const resolved =
        link.kind === 'wikilink'
          ? resolveWikiStem(link.rawTarget, docs)
          : resolvePathTarget(link.rawTarget, sourcePaths.get(link.sourceDocId) ?? '', docs);
      if (!resolved) continue;

      const state: 'resolved' | 'dangling_anchor' =
        link.anchor && !(await anchors(resolved.docId)).has(link.anchor)
          ? 'dangling_anchor'
          : 'resolved';

      await tx.db
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
    const queryVec = await this.embeddings.embedQuery(query);
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
             (SELECT count(*) FROM knowledge_chunks mc
               WHERE mc.project_id = ${projectId}
                 AND mc.tsv @@ plainto_tsquery('english', ${query}))::int AS matched_total
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

    // How much of the corpus actually matched, counted over the whole project
    // rather than over the fusion pool.
    //
    // The lexical arm is the only one with a relevance *predicate*: `tsv @@
    // query` either matches or it does not. The dense arm is a ranker — with
    // no distance threshold it returns its top `pool` rows for any query at
    // all, relevant or not. Counting the fused pool therefore reported
    // "matched" ≈ pool on every single query, so the truncation notice fired
    // on essentially every draft with a number that meant nothing. A notice
    // that always fires is a notice the agent learns to skip, which is worse
    // than no notice at all.
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
        edge_id: string;
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
        SELECT l.id, l.source_doc_id, l.resolved_doc_id, l.kind, l.site
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
        SELECT r.id, r.resolved_doc_id AS neighbor_id, r.kind, r.source_doc_id AS seed_doc_id, r.site
        FROM resolved r WHERE r.source_doc_id = ANY(${seedDocIds})
        UNION ALL
        SELECT r.id, r.source_doc_id AS neighbor_id, r.kind, r.resolved_doc_id AS seed_doc_id, r.site
        FROM resolved r WHERE r.resolved_doc_id = ANY(${seedDocIds})
      )
      SELECT h.id AS edge_id, h.neighbor_id, kd.path AS neighbor_path, h.kind, h.seed_doc_id,
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
    const seedScore = new Map(seeds.map((c) => [c.docId, c.score]));
    const byNeighbor = new Map<
      string,
      { weight: number; seedOrd: number; edgeLabel: string; edgeId: string; score: number }
    >();
    for (const edge of edges) {
      if (edge.degree > HUB_DEGREE) continue;
      const weight = EDGE_WEIGHT[edge.kind as LinkKind] ?? 0.3;
      const seedOrd = seedRank.get(edge.seed_doc_id) ?? seedDocIds.length;
      const label = `${edge.kind} ${edge.site ? `at ${edge.source_path}#${edge.site}` : `from ${edge.source_path}`}`;
      const current = byNeighbor.get(edge.neighbor_id);
      if (!current || weight > current.weight || (weight === current.weight && seedOrd < current.seedOrd)) {
        byNeighbor.set(edge.neighbor_id, {
          weight,
          seedOrd,
          edgeLabel: label,
          edgeId: edge.edge_id,
          score: (seedScore.get(edge.seed_doc_id) ?? 0) * weight * GRAPH_SCORE_DISCOUNT,
        });
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
        score: byNeighbor.get(row.doc_id)?.score ?? 0,
        via: 'graph' as const,
        viaEdge: byNeighbor.get(row.doc_id)?.edgeLabel,
        viaEdgeId: byNeighbor.get(row.doc_id)?.edgeId,
      }));
  }

  /**
   * Record default-branch commits from a push webhook (0013).
   *
   * This is history for repositories specd cannot clone. Idempotent on
   * (repository, sha) because deliveries retry, and pruned to the coupling
   * window so the ledger does not grow without bound.
   */
  async recordCommits(repo: Repository, commits: HistoryCommit[]): Promise<void> {
    if (commits.length === 0) return;

    await this.db
      .insert(repoCommits)
      .values(
        commits.map((c) => ({
          repositoryId: repo.id,
          sha: c.sha,
          committedAt: c.at,
          files: c.files,
        })),
      )
      .onConflictDoNothing();

    await this.handle.sql`
      DELETE FROM repo_commits
      WHERE repository_id = ${repo.id}
        AND committed_at < now() - make_interval(days => ${COUPLING_WINDOW_DAYS})
    `;
  }

  /**
   * History for a repo, from wherever it can be had.
   *
   * A local repo has a working tree, so `git log` answers completely and
   * immediately. A hosted one has the ledger, which is accurate for
   * everything since specd was installed and empty before it — a lower bound
   * that grows, never a guess.
   */
  private async historyFor(
    repo: Repository,
    target: ReturnType<VcsService['toTarget']>,
    since: Date,
  ): Promise<HistoryCommit[]> {
    if (repo.provider === 'local') {
      try {
        return await this.vcs.localAdapter.commitFiles(target, since);
      } catch {
        return [];
      }
    }

    const rows = await this.handle.sql<
      { sha: string; committed_at: Date; files: string[] }[]
    >`
      SELECT sha, committed_at, files
      FROM repo_commits
      -- ISO text with an explicit cast: the pool disables postgres.js type
      -- handling, so it will not serialize a Date parameter for us.
      WHERE repository_id = ${repo.id} AND committed_at >= ${since.toISOString()}::timestamptz
      ORDER BY committed_at
    `;
    return rows.map((r) => ({ sha: r.sha, at: new Date(r.committed_at), files: r.files ?? [] }));
  }

  /**
   * Recount code commits since each doc last changed. Outside the index
   * transaction on purpose: it is a derived hint, and a git call per doc must
   * not hold write locks or fail a run that has already succeeded.
   */
  private async refreshDrift(repo: Repository, target: ReturnType<VcsService['toTarget']>): Promise<void> {
    const docs = await this.db
      .select({ id: knowledgeDocs.id, path: knowledgeDocs.path, docUpdatedAt: knowledgeDocs.docUpdatedAt })
      .from(knowledgeDocs)
      .where(eq(knowledgeDocs.repositoryId, repo.id));

    const since = new Date(Date.now() - COUPLING_WINDOW_DAYS * 86_400_000);
    const history = await this.historyFor(repo, target, since);
    if (history.length === 0) return;

    // A hosted repo has no per-file commit date from its API, but the ledger
    // knows when each doc was last touched. Deriving it here is what stops
    // freshness reporting "unmeasured" forever on a repo specd cannot clone.
    const docTouchedAt = new Map<string, Date>();
    for (const commit of history) {
      for (const file of commit.files) {
        const at = docTouchedAt.get(file);
        if (!at || commit.at > at) docTouchedAt.set(file, commit.at);
      }
    }

    for (const doc of docs) {
      const derived = doc.docUpdatedAt ?? docTouchedAt.get(doc.path) ?? null;
      if (!derived) continue;

      // Repo-wide fallback: blunt, but it is all there is for a doc that has
      // never moved with any code.
      const commitsSince = history.filter(
        (c) => c.at > derived && c.files.some((f) => !f.startsWith(KNOWLEDGE_PREFIX)),
      ).length;

      await this.db
        .update(knowledgeDocs)
        .set({ codeCommitsSince: commitsSince, docUpdatedAt: derived })
        .where(eq(knowledgeDocs.id, doc.id));
    }

    await this.refreshCoupling(repo, history, docs);
  }

  /**
   * Doc↔code coupling from one history walk (0013).
   *
   * Replaced wholesale per run rather than merged: coupling is a function of
   * the window, and a stale edge from outside it would linger forever with no
   * commit left to justify it.
   */
  private async refreshCoupling(
    repo: Repository,
    commits: HistoryCommit[],
    docs: { id: string; path: string }[],
  ): Promise<void> {
    const idByPath = new Map(docs.map((d) => [d.path, d.id]));
    const perDoc = new Map<string, number>();
    const rows: (typeof knowledgeDocCoupling.$inferInsert)[] = [];

    // couplingFrom returns strongest-first, so taking the first few per doc
    // keeps the rows worth reading.
    for (const edge of couplingFrom(commits)) {
      const docId = idByPath.get(edge.docPath);
      if (!docId) continue;
      const taken = perDoc.get(docId) ?? 0;
      if (taken >= COUPLING_PER_DOC) continue;
      perDoc.set(docId, taken + 1);
      rows.push({
        projectId: repo.projectId,
        docId,
        codePath: edge.codePath,
        commitsTogether: edge.commitsTogether,
        lastTogetherAt: edge.lastTogetherAt,
        commitsSince: edge.commitsSince,
      });
    }

    await this.handle.transaction(async (tx) => {
      await tx.sql`
        DELETE FROM knowledge_doc_coupling
        WHERE doc_id IN (SELECT id FROM knowledge_docs WHERE repository_id = ${repo.id})
      `;
      if (rows.length > 0) await tx.db.insert(knowledgeDocCoupling).values(rows);
    });
  }

  /**
   * What the corpus could have answered, alongside what it did (S-102 T-verdict).
   *
   * Citation checking that only knows the retrieved set can say "not
   * retrieved" but not "not real", so every gap in coverage reads as a
   * fabrication. These two queries are what let the two be told apart.
   */
  async coverageFor(projectId: string, retrievedPaths: string[]): Promise<CitationCoverage> {
    const docs = await this.handle.sql<{ path: string; has_chunks: boolean }[]>`
      SELECT kd.path,
             EXISTS (SELECT 1 FROM knowledge_chunks c WHERE c.doc_id = kd.id) AS has_chunks
      FROM knowledge_docs kd
      WHERE kd.project_id = ${projectId}
    `;

    const anchorsByPath: Record<string, string[]> = {};
    const wanted = [...new Set(retrievedPaths)];
    if (wanted.length > 0) {
      const bodies = await this.handle.sql<{ path: string; content: string }[]>`
        SELECT path, content FROM knowledge_docs
        WHERE project_id = ${projectId} AND path = ANY(${wanted})
      `;
      for (const doc of bodies) {
        anchorsByPath[doc.path] = [...headingAnchorsOf(doc.content)];
      }
    }

    return {
      knownPaths: docs.map((d) => d.path),
      anchorsByPath,
      unretrievablePaths: docs.filter((d) => !d.has_chunks).map((d) => d.path),
      truncatedCount: 0,
    };
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
        codeCommitsSince: knowledgeDocs.codeCommitsSince,
        repositoryId: knowledgeDocs.repositoryId,
      })
      .from(knowledgeDocs)
      .where(where)
      .orderBy(knowledgeDocs.path);

    const coupling = await this.topCoupling(projectId);
    return rows.map((row) => ({
      ...row,
      coupledTo: coupling.get(row.id) ?? null,
      freshness: freshnessOf(row.docUpdatedAt, row.isStub, row.codeCommitsSince, coupling.get(row.id)),
    }));
  }

  /** The most-drifted coupled area per doc — one row each, for the doc list. */
  private async topCoupling(
    projectId: string,
  ): Promise<Map<string, { codePath: string; commitsSince: number }>> {
    const rows = await this.handle.sql<
      { doc_id: string; code_path: string; commits_since: number }[]
    >`
      SELECT DISTINCT ON (doc_id) doc_id, code_path, commits_since
      FROM knowledge_doc_coupling
      WHERE project_id = ${projectId}
      ORDER BY doc_id, commits_since DESC, commits_together DESC
    `;
    return new Map(
      rows.map((r) => [r.doc_id, { codePath: r.code_path, commitsSince: Number(r.commits_since) }]),
    );
  }

  /** Everything history says a doc moves with (0013), strongest first. */
  async docCoupling(projectId: string, docId: string) {
    const rows = await this.handle.sql<
      { code_path: string; commits_together: number; commits_since: number }[]
    >`
      SELECT code_path, commits_together, commits_since
      FROM knowledge_doc_coupling
      WHERE project_id = ${projectId} AND doc_id = ${docId}
      ORDER BY commits_together DESC, commits_since DESC
    `;
    return rows.map((r) => ({
      codePath: r.code_path,
      commitsTogether: Number(r.commits_together),
      commitsSince: Number(r.commits_since),
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
      {
        kind: string;
        raw_target: string;
        site: string | null;
        state: string;
        target_path: string | null;
        stale: boolean | null;
      }[]
    >`
      SELECT l.kind, l.raw_target, l.site, l.resolution_state AS state,
             COALESCE(kd.path, cn.path) AS target_path,
             (l.target_blob_sha IS NOT NULL AND cn.blob_sha IS NOT NULL
                AND l.target_blob_sha <> cn.blob_sha) AS stale
      FROM knowledge_doc_links l
      LEFT JOIN knowledge_docs kd ON kd.id = l.resolved_doc_id
      LEFT JOIN code_nodes cn ON cn.id = l.resolved_code_id
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
        stale: Boolean(l.stale),
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
  async recomputeHealth(projectId: string, ctx: DbContext = this.handle): Promise<void> {
    const docs = await ctx.db
      .select({
        id: knowledgeDocs.id,
        docUpdatedAt: knowledgeDocs.docUpdatedAt,
        indexedAt: knowledgeDocs.indexedAt,
        isStub: knowledgeDocs.isStub,
        hasUnverified: knowledgeDocs.hasUnverified,
        codeCommitsSince: knowledgeDocs.codeCommitsSince,
        kind: knowledgeDocs.kind,
        path: knowledgeDocs.path,
      })
      .from(knowledgeDocs)
      .where(eq(knowledgeDocs.projectId, projectId));

    const docCount = docs.length;
    const asBuiltCount = docs.filter((d) => d.kind === 'spec').length;
    const stubs = docs.filter((d) => d.isStub);
    const coupling = await this.topCoupling(projectId);
    const freshnessFor = (d: (typeof docs)[number]) =>
      freshnessOf(d.docUpdatedAt, d.isStub, d.codeCommitsSince, coupling.get(d.id));
    const stale = docs.filter((d) => freshnessFor(d).stale && !d.isStub);
    const unverified = docs.filter((d) => d.hasUnverified);

    // Graph health (S-102): links that point nowhere, anchors that no longer
    // exist, and docs nothing links to. Cheap SQL over the links table.
    const [graph] = await ctx.sql<
      {
        broken: number;
        broken_code: number;
        stale_code: number;
        dangling: number;
        orphans: number;
        total_links: number;
        undeclared: number;
      }[]
    >`
      SELECT
        (SELECT count(*) FROM knowledge_doc_links
          WHERE project_id = ${projectId} AND resolution_state = 'unresolved'
            AND kind NOT IN ('coderef', 'symbolref'))::int AS broken,
        -- Docs pointing at source files that are not there any more. Its own
        -- number: a dead link between docs and a doc describing code that was
        -- deleted are different repairs.
        (SELECT count(*) FROM knowledge_doc_links
          WHERE project_id = ${projectId} AND resolution_state = 'unresolved'
            AND kind IN ('coderef', 'symbolref'))::int AS broken_code,
        -- Still resolves, but the file has changed since the doc was last
        -- touched. Not broken — nobody came back to check.
        (SELECT count(*) FROM knowledge_doc_links l
          JOIN code_nodes cn ON cn.id = l.resolved_code_id
          WHERE l.project_id = ${projectId}
            AND l.target_blob_sha IS NOT NULL
            AND cn.blob_sha IS NOT NULL
            AND l.target_blob_sha <> cn.blob_sha)::int AS stale_code,
        (SELECT count(*) FROM knowledge_doc_links
          WHERE project_id = ${projectId} AND resolution_state = 'dangling_anchor')::int AS dangling,
        (SELECT count(*) FROM knowledge_doc_links
          WHERE project_id = ${projectId})::int AS total_links,
        -- Integrity audit: rows using vocabulary this build does not declare.
        -- Should always be zero; if it is not, a producer or a migration has
        -- written something no consumer knows how to weight or resolve, and
        -- silence about that is how a graph rots invisibly.
        (SELECT count(*) FROM knowledge_doc_links
          WHERE project_id = ${projectId}
            AND (kind <> ALL(${LINK_KINDS.map((k) => k.kind)})
              OR resolution_state <> ALL(${[...RESOLUTION_STATES]})
              OR origin_tier <> ALL(${[...ORIGIN_TIERS]})))::int AS undeclared,
        (SELECT count(*) FROM knowledge_docs kd
          WHERE kd.project_id = ${projectId}
            -- The map itself is nobody's target. An index page having no
            -- inbound links is how index pages work, and dinging every project
            -- for it forever would make the number unreachable and ignorable.
            AND kd.path <> ${`${KNOWLEDGE_PREFIX}README.md`}
            AND NOT EXISTS (
              SELECT 1 FROM knowledge_doc_links l
              WHERE l.project_id = ${projectId}
                AND l.resolved_doc_id = kd.id
                AND l.resolution_state = 'resolved'
            ))::int AS orphans
    `;
    const brokenLinks = Number(graph?.broken ?? 0);
    const brokenCodeRefs = Number(graph?.broken_code ?? 0);
    const staleCodeRefs = Number(graph?.stale_code ?? 0);
    const danglingAnchors = Number(graph?.dangling ?? 0);
    const orphanDocs = Number(graph?.orphans ?? 0);
    const totalLinks = Number(graph?.total_links ?? 0);
    const undeclaredEdges = Number(graph?.undeclared ?? 0);
    const unknownFreshness = docs.filter((d) => freshnessFor(d).unknown && !d.isStub).length;

    let score = 100;
    if (docCount === 0) {
      score = 0;
    } else {
      score -= (stale.length / docCount) * 40;
      score -= (stubs.length / docCount) * 25;
      score -= (unverified.length / docCount) * 20;
      // Graph rot counts against the score it was already being measured
      // beside. Broken edges are scored as a *rate* over the edges that exist,
      // so a well-linked base with one dead link is not judged like a
      // two-link base with one dead link.
      if (totalLinks > 0) {
        score -= ((brokenLinks + danglingAnchors + brokenCodeRefs) / totalLinks) * 15;
      }
      score -= (orphanDocs / docCount) * 10;
      // Never fully penalise a young knowledge base for having no history yet.
      score = Math.max(0, Math.min(100, score));
    }

    const notes: { icon: string; text: string }[] = [];
    for (const doc of stale.slice(0, 3)) {
      const reason = freshnessFor(doc).reason;
      notes.push({ icon: '⚠', text: `${doc.path} — ${reason ?? 'stale'}.` });
    }
    if (unknownFreshness > 0) {
      notes.push({
        icon: '🕗',
        text:
          `${unknownFreshness} doc${unknownFreshness === 1 ? '' : 's'} have no commit date, so ` +
          `drift cannot be measured for them — not the same as being fresh.`,
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
    if (brokenCodeRefs > 0) {
      notes.push({
        icon: '🧩',
        text:
          `${brokenCodeRefs} reference${brokenCodeRefs === 1 ? '' : 's'} to code that is no longer ` +
          `there — the doc is describing a file or a symbol that moved or was deleted.`,
      });
    }
    if (staleCodeRefs > 0) {
      notes.push({
        icon: '🕰',
        text:
          `${staleCodeRefs} doc reference${staleCodeRefs === 1 ? '' : 's'} point at code that has ` +
          `changed since the doc was last touched — still there, not re-read.`,
      });
    }
    if (undeclaredEdges > 0) {
      notes.push({
        icon: '🧬',
        text:
          `${undeclaredEdges} edge${undeclaredEdges === 1 ? '' : 's'} use a kind, state or tier ` +
          `this build does not declare — retrieval cannot weight them correctly.`,
      });
    }
    if (docCount > 3 && orphanDocs > 0) {
      notes.push({
        icon: '🏝',
        text: `${orphanDocs} doc${orphanDocs === 1 ? ' is' : 's are'} linked from nowhere — knowledge nobody will find by following anything.`,
      });
    }

    await ctx.sql`
      INSERT INTO knowledge_health (
        project_id, score, doc_count, stale_count, stub_count, as_built_count,
        broken_links, dangling_anchors, orphan_docs, unknown_freshness_count, notes, computed_at)
      VALUES (${projectId}, ${score}, ${docCount}, ${stale.length}, ${stubs.length}, ${asBuiltCount},
              ${brokenLinks}, ${danglingAnchors}, ${orphanDocs}, ${unknownFreshness},
              ${JSON.stringify(notes)}::jsonb, now())
      ON CONFLICT (project_id) DO UPDATE SET
        score = EXCLUDED.score,
        doc_count = EXCLUDED.doc_count,
        stale_count = EXCLUDED.stale_count,
        stub_count = EXCLUDED.stub_count,
        as_built_count = EXCLUDED.as_built_count,
        broken_links = EXCLUDED.broken_links,
        dangling_anchors = EXCLUDED.dangling_anchors,
        orphan_docs = EXCLUDED.orphan_docs,
        unknown_freshness_count = EXCLUDED.unknown_freshness_count,
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

/** Insert or update one doc row. Transaction-scoped: no ambient handle. */
async function upsertDoc(
  tx: DbContext,
  repo: Repository,
  doc: PreparedDoc,
  fingerprint: string,
): Promise<string> {
  const values = {
    projectId: repo.projectId,
    repositoryId: repo.id,
    path: doc.path,
    kind: doc.kind,
    title: doc.title,
    sha: doc.sha,
    content: doc.content,
    docUpdatedAt: doc.docUpdatedAt,
    indexedAt: new Date(),
    hasUnverified: doc.hasUnverified,
    isStub: doc.isStub,
    linksVersion: LINKS_VERSION,
    indexFingerprint: fingerprint,
  };

  if (doc.existingId) {
    await tx.db.update(knowledgeDocs).set(values).where(eq(knowledgeDocs.id, doc.existingId));
    return doc.existingId;
  }

  const [row] = await tx.db
    .insert(knowledgeDocs)
    .values(values)
    .returning({ id: knowledgeDocs.id });
  if (!row) throw new Error('failed to insert knowledge doc');
  return row.id;
}

/**
 * Replace a doc's chunks. One statement per doc rather than one per chunk:
 * `unnest` zips the column arrays back into rows, and the explicit `::vector`
 * cast keeps pgvector literals unambiguous.
 */
async function writeChunks(
  tx: DbContext,
  docId: string,
  projectId: string,
  doc: PreparedDoc,
): Promise<void> {
  await tx.db.delete(knowledgeChunks).where(eq(knowledgeChunks.docId, docId));
  if (doc.chunks.length === 0) return;

  const vectors = doc.chunks.map((_, i) => {
    const vec = doc.vectors[i];
    return vec ? EmbeddingService.toSqlVector(vec) : null;
  });

  await tx.sql`
    INSERT INTO knowledge_chunks (doc_id, project_id, ord, heading, text, tokens, embedding)
    SELECT ${docId}, ${projectId}, u.ord, u.heading, u.text, u.tokens, u.embedding::vector
    FROM unnest(
      ${doc.chunks.map((c) => c.ord)}::int[],
      ${doc.chunks.map((c) => c.heading)}::text[],
      ${doc.chunks.map((c) => c.text)}::text[],
      ${doc.chunks.map((c) => c.tokens)}::int[],
      ${vectors}::text[]
    ) AS u(ord, heading, text, tokens, embedding)
  `;
}

/**
 * Replace one doc's outbound edges from a fresh extraction (S-102).
 *
 * Scoped to the deterministic tier: a later LLM-derived tier coexists in the
 * same table and a re-extract of one must never wipe the other. Links that do
 * not resolve are kept as `unresolved` — flag, don't drop.
 */
async function writeLinks(
  tx: DbContext,
  docId: string,
  projectId: string,
  sourcePath: string,
  content: string,
  docs: ResolvableDoc[],
  anchors: AnchorLookup,
  /** The file tree a `coderef` resolves against, and what counts as ours. */
  scope: {
    code: ResolvableCode[];
    ownTopLevel: Set<string>;
    symbols: Map<string, string>;
    symbolParents: Set<string>;
    shaByPath: Map<string, string>;
  },
  /** Research records document other people's code; see the coderef branch. */
  kind: KnowledgeDocKind,
): Promise<void> {
  await tx.db
    .delete(knowledgeDocLinks)
    .where(
      and(
        eq(knowledgeDocLinks.sourceDocId, docId),
        eq(knowledgeDocLinks.originTier, 'deterministic'),
      ),
    );

  const extracted = extractLinks(content);
  if (extracted.length === 0) return;

  const rows: (typeof knowledgeDocLinks.$inferInsert)[] = [];
  for (const link of extracted) {
    if (link.kind === 'symbolref') {
      const id = scope.symbols.get(link.rawTarget);
      // A member whose container we indexed, and which is not there: it was
      // ours and it is gone. Both of this repository's own cases are real —
      // `Config.redisUrl` went with the queue, `PipelineService.reindex` was
      // renamed. Where the container is unknown too, the reference was never
      // ours to check and is dropped rather than reported.
      if (!id && !scope.symbolParents.has(link.rawTarget.split('.')[0] ?? '')) continue;
      rows.push({
        projectId,
        sourceDocId: docId,
        kind: link.kind,
        site: link.site,
        rawTarget: link.rawTarget,
        resolvedCodeId: id ?? null,
        resolutionState: id ? 'resolved' : 'unresolved',
      });
      continue;
    }

    if (link.kind === 'coderef') {
      // A research record's paths point into the system it describes, not into
      // this repository — resolving them would report someone else's file tree
      // as our broken references.
      if (kind === 'research') continue;
      const hit = resolveCodeTarget(link.rawTarget, scope.code);
      // Out of scope rather than broken: a path whose first segment is not a
      // directory of this repo was never ours to resolve.
      if (!hit && !scope.ownTopLevel.has(link.rawTarget.split('/')[0] ?? '')) continue;
      rows.push({
        projectId,
        sourceDocId: docId,
        kind: link.kind,
        site: link.site,
        rawTarget: link.rawTarget,
        resolvedCodeId: hit?.id ?? null,
        resolutionState: hit ? 'resolved' : 'unresolved',
        // Frozen at this doc's last indexing. When the file moves on without
        // the doc, the two stop matching — which is what stale means, as
        // opposed to broken.
        targetBlobSha: hit ? (scope.shaByPath.get(hit.path) ?? null) : null,
      });
      continue;
    }

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

    let state: 'resolved' | 'unresolved' | 'dangling_anchor' = resolved ? 'resolved' : 'unresolved';
    if (resolved && link.anchor && !(await anchors(resolved.docId)).has(link.anchor)) {
      state = 'dangling_anchor';
    }

    rows.push({
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

  if (rows.length > 0) await tx.db.insert(knowledgeDocLinks).values(rows);
}

/** Heading anchors per target doc, read once and reused for the whole run. */
function anchorLookup(tx: DbContext): AnchorLookup {
  const cache = new Map<string, Set<string>>();
  return async (docId: string) => {
    const hit = cache.get(docId);
    if (hit) return hit;
    const [row] = await tx.db
      .select({ content: knowledgeDocs.content })
      .from(knowledgeDocs)
      .where(eq(knowledgeDocs.id, docId))
      .limit(1);
    const set = row ? headingAnchorsOf(row.content) : new Set<string>();
    cache.set(docId, set);
    return set;
  };
}

async function edgeCountsBySource(
  tx: DbContext,
  projectId: string,
): Promise<Map<string, number>> {
  const rows = await tx.sql<{ source_doc_id: string; n: number }[]>`
    SELECT source_doc_id, count(*)::int AS n
    FROM knowledge_doc_links
    WHERE project_id = ${projectId}
    GROUP BY source_doc_id
  `;
  return new Map(rows.map((row) => [row.source_doc_id, Number(row.n)]));
}

/**
 * Refuse a re-index that would silently gut the repo's slice of the index.
 *
 * Exported for direct testing. Removing a handful of docs is normal
 * maintenance; removing most of them at once is almost always a bad listing
 * (wrong branch, revoked token, empty response), and committing it destroys
 * every edge into those docs too. The error says exactly how to proceed when
 * the mass deletion is real.
 *
 * A listing that came back *empty* is refused whatever the size of the index:
 * "the directory is gone" and "the request failed politely" produce the same
 * empty array, and only one of them should be allowed to erase a knowledge
 * base. That case is why the count floor alone was not enough — three docs
 * vanishing from a three-doc repo used to pass.
 */
export function assertNoUnexplainedShrink(
  storedCount: number,
  removalCount: number,
  listedCount: number,
  repoName: string,
): void {
  if (removalCount === 0) return;

  const gutted = listedCount === 0 && storedCount > 0;
  const disproportionate = removalCount >= SHRINK_GUARD_MIN_REMOVALS && removalCount * 2 > storedCount;
  if (!gutted && !disproportionate) return;

  throw new Error(
    `Refusing to re-index ${repoName}: this run would remove ${removalCount} of ` +
      `${storedCount} indexed knowledge doc(s)${listedCount === 0 ? ', having listed none at all' : ''}. ` +
      `That usually means the listing was wrong (branch, token, network), not that ` +
      `the docs are gone. If the deletion is real, remove and re-add the repository — ` +
      `or delete the docs in smaller batches — and the index will follow.`,
  );
}

/**
 * Refuse a re-index that would drop edges nobody asked it to touch (S-102).
 *
 * A doc's edges may legitimately disappear two ways: the doc was re-extracted
 * this run (its deterministic tier is replaced wholesale) or the doc was
 * deleted (cascade). Any other source doc losing edges means something removed
 * rows outside those two paths — a stray delete, a cascade nobody intended, a
 * bad migration — and the transaction is rolled back rather than committed.
 *
 * This is the provenance half of the guard: the doc-count check above reasons
 * about volume, which cannot tell a legitimate mass deletion from an accident.
 * This one reasons about *authorisation*, which can.
 *
 * Exported for direct testing — the pipeline cannot easily be talked into
 * producing the input this has to refuse.
 */
export async function assertNoUnexplainedEdgeLoss(
  tx: DbContext,
  projectId: string,
  before: Map<string, number>,
  touched: Set<string>,
  repoName: string,
): Promise<void> {
  const after = await edgeCountsBySource(tx, projectId);

  let lost = 0;
  const casualties: string[] = [];
  for (const [docId, had] of before) {
    if (touched.has(docId)) continue;
    const has = after.get(docId) ?? 0;
    if (has >= had) continue;
    lost += had - has;
    casualties.push(docId);
  }
  if (casualties.length === 0) return;

  throw new Error(
    `Refusing to re-index ${repoName}: this run would drop ${lost} link(s) from ` +
      `${casualties.length} doc(s) it never re-indexed or deleted ` +
      `(${casualties.slice(0, 3).join(', ')}${casualties.length > 3 ? ', …' : ''}). ` +
      `Edges only disappear when their source doc is re-extracted or removed, so ` +
      `this is a bug in the indexer, not a change in the repository.`,
  );
}

function classify(path: string): KnowledgeDocKind {
  if (path.includes('/research/')) return 'research';
  if (path.includes('/specs/')) return 'spec';
  if (path.includes('/decisions/')) return 'adr';
  if (path.includes('/runbooks/')) return 'runbook';
  return 'doc';
}

function firstHeading(content: string): string | null {
  const match = /^#\s+(.+)$/m.exec(content);
  return match?.[1]?.trim() ?? null;
}

/**
 * How fresh a doc is, or an admission that we cannot tell.
 *
 * `docUpdatedAt` is null wherever the provider gives us no commit date, which
 * today is every doc of a GitHub- or GitLab-backed repo. Falling back to
 * `indexedAt` there — which is always "just now" for a doc we just indexed —
 * reported every such doc as permanently fresh. That is a false negative
 * hiding exactly the rot the number exists to expose, so unmeasurable is now
 * its own answer rather than a good one.
 */
function freshnessOf(
  docUpdatedAt: Date | null,
  isStub: boolean,
  codeCommitsSince?: number | null,
  /** The strongest coupled area, when history has been mined (0013). */
  coupling?: { codePath: string; commitsSince: number } | null,
) {
  if (!docUpdatedAt) {
    return {
      score: null,
      ageDays: null,
      stale: false,
      unknown: true,
      reason: isStub
        ? 'generated stub, never filled in'
        : 'no commit date from this provider — freshness unmeasured',
    };
  }

  const ageDays = Math.floor((Date.now() - docUpdatedAt.getTime()) / 86_400_000);
  // Measured drift beats the calendar: a doc untouched for a year beside code
  // untouched for a year has not drifted from anything.
  // Coupled drift wins when we have it: "6 commits touched apps/api/src/"
  // names the code to compare against, where "25 commits touched code" only
  // says the repository is alive.
  const driftCommits = coupling?.commitsSince ?? codeCommitsSince ?? 0;
  const drifted = driftCommits >= DRIFT_COMMITS;
  const stale = drifted || ageDays > STALE_AFTER_DAYS;
  return {
    score: Math.max(0, 100 - (ageDays / STALE_AFTER_DAYS) * 100),
    ageDays,
    stale,
    unknown: false,
    reason: isStub
      ? 'generated stub, never filled in'
      : drifted
        ? coupling
          ? `${coupling.commitsSince} commits touched ${coupling.codePath} since this doc last moved with it`
          : `${codeCommitsSince} commits touched code since this doc last changed`
        : stale
          ? `${ageDays}d since last change`
          : undefined,
  };
}
