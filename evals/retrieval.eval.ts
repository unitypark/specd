/**
 * Retrieval quality against a labelled set.
 *
 * Small and honest: fifteen questions whose answer is a specific doc in this
 * repository's own knowledge base. That is a real benchmark and a tiny one,
 * and the number it produces should be read as a regression guard and a
 * direction, not as a score anybody should quote.
 *
 * Saying so matters, because the failure this is modelled on is the opposite:
 * the benchmarked engine reports a 12-point lift on six graded questions
 * (knowledge/research/code-graph-rag-engine-analysis.md#6), which is not a
 * measurement.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createDb, projects, repositories, type DbHandle, type Repository } from '@specd/db';
import { KnowledgeService } from '../apps/api/src/knowledge/knowledge.service.js';
import { EmbeddingService } from '../apps/api/src/knowledge/embeddings.js';
import type { VcsService } from '../apps/api/src/vcs/vcs.service.js';
import { Config } from '../apps/api/src/config.js';

/** question → the doc that answers it. */
export const LABELLED: { q: string; expect: string }[] = [
  { q: 'how does a runner claim a queued job', expect: 'knowledge/decisions/0004-runner-job-dispatch.md' },
  { q: 'why was redis and bullmq removed', expect: 'knowledge/decisions/0008-remove-unused-queue.md' },
  { q: 'pairing a runner before dispatch', expect: 'knowledge/decisions/0003-runner-pairing-before-dispatch.md' },
  { q: 'connecting gitlab with a personal access token', expect: 'knowledge/decisions/0002-gitlab-via-personal-access-token.md' },
  { q: 'how do I run the platform locally for the first time', expect: 'knowledge/runbooks/local-dev.md' },
  { q: 'link aware retrieval and knowledge graph health', expect: 'knowledge/specs/S-102-knowledge-graph-link-aware-retrieval-and-health.md' },
  { q: 'reclaiming jobs abandoned by a dead runner', expect: 'knowledge/specs/S-101-reclaim-jobs-abandoned-by-a-dead-runner.md' },
  { q: 'why the cli uses a repl', expect: 'knowledge/decisions/0006-cli-repl-bubbletea.md' },
  { q: 'adopting spec driven delivery', expect: 'knowledge/decisions/0001-adopt-spec-driven.md' },
  { q: 'mirroring tickets to jira with an api token', expect: 'knowledge/decisions/0010-jira-via-api-token-and-a-mirror-that-cannot-fail.md' },
  { q: 'git credentials for a build dispatched to a runner', expect: 'knowledge/decisions/0009-build-dispatch-runner-git-credentials.md' },
  { q: 'index runs woken by listen notify', expect: 'knowledge/decisions/0012-index-runs-queued-and-woken-by-listen-notify.md' },
  { q: 'doc to code coupling mined from history', expect: 'knowledge/decisions/0013-doc-code-coupling-from-git-history.md' },
  { q: 'indexing code not only documents', expect: 'knowledge/decisions/0014-the-index-holds-code-not-only-docs.md' },
  { q: 'specd developing specd on itself', expect: 'knowledge/decisions/0011-specd-develops-specd.md' },
];

const REPO = process.cwd();

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.md') ? [p] : [];
  });

export interface RetrievalScore {
  questions: number;
  /** Answer doc anywhere in the returned chunks. */
  recall: number;
  /** Answer doc in the first three. */
  recallAt3: number;
  /** Mean reciprocal rank of the answer doc, by first appearance. */
  mrr: number;
  misses: string[];
}

export async function scoreRetrieval(limit = 8): Promise<RetrievalScore> {
  const url = process.env.DATABASE_URL ?? 'postgres://specd:specd@localhost:5433/specd';
  process.env.JWT_SECRET ??= 'test';
  process.env.VAULT_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');

  const handle: DbHandle = createDb(url, { max: 4 });
  const files = new Map<string, string>();
  for (const abs of walk(join(REPO, 'knowledge'))) {
    files.set(abs.replace(`${REPO}/`, ''), readFileSync(abs, 'utf8'));
  }

  const vcs = {
    adapterFor: async () => ({
      listFiles: async () => [...files.keys()],
      listFilesWithSha: async () => [...files.keys()].map((path) => ({ path, sha: path })),
      readFiles: async (_t: unknown, paths: string[]) =>
        paths.filter((p) => files.has(p)).map((p) => ({ path: p, content: files.get(p)! })),
    }),
    toTarget: () => ({}),
    localAdapter: { lastCommitDate: async () => null, commitFiles: async () => [] },
  } as unknown as VcsService;

  const config = new Config();
  const knowledge = new KnowledgeService(handle.db, handle, vcs, new EmbeddingService(config));

  const [project] = await handle.db
    .insert(projects)
    .values({ slug: `eval-${Date.now()}`, name: 'Retrieval eval' })
    .returning();
  const projectId = project!.id;
  const [repoRow] = await handle.db
    .insert(repositories)
    .values({ projectId, provider: 'local', name: 'eval/kb', isPrimary: true })
    .returning();

  try {
    await knowledge.indexRepository(repoRow as Repository);

    let hits = 0;
    let hitsAt3 = 0;
    let rr = 0;
    const misses: string[] = [];

    for (const { q, expect } of LABELLED) {
      const { chunks } = await knowledge.retrieve(projectId, q, limit);
      const paths = chunks.map((c) => c.path);
      const at = paths.indexOf(expect);
      if (at === -1) {
        misses.push(`${q}  →  wanted ${expect.replace('knowledge/', '')}, got ${paths[0]?.replace('knowledge/', '') ?? 'nothing'}`);
        continue;
      }
      hits += 1;
      if (at < 3) hitsAt3 += 1;
      rr += 1 / (at + 1);
    }

    const n = LABELLED.length;
    return { questions: n, recall: hits / n, recallAt3: hitsAt3 / n, mrr: rr / n, misses };
  } finally {
    await handle.db.delete(projects).where(eq(projects.id, projectId));
    await handle.close();
  }
}
