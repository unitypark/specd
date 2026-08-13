import { describe, expect, it } from 'vitest';
import { collectEvidence, renderScaffold, type DetectedStack } from '@specd/templates';
import { extractLinks } from './link-extract.js';
import { resolvePathTarget, resolveWikiStem, type ResolvableDoc } from './link-resolve.js';

/**
 * The scaffold a freshly onboarded repo receives, put through the real link
 * extractor and resolver.
 *
 * This exists because the two halves were written apart and drifted: the
 * generator emitted its reading order as backticked bare filenames
 * (`architecture.md`), which no extraction rule matches, so every customer
 * adopted a knowledge base in which nothing linked to anything. Graph
 * expansion had no edges to expand across and health reported every doc as an
 * orphan — a first impression of the product's own feature working perfectly
 * and finding nothing.
 *
 * Asserting on the generator's text would just restate it. Asserting through
 * the extractor is what pins the contract between them.
 */

const stack: DetectedStack = {
  language: 'TypeScript',
  framework: 'NestJS',
  packageManager: 'pnpm',
  testRunner: 'Vitest',
  verifyCommand: 'pnpm typecheck && pnpm test',
  extras: [],
};

/**
 * Two shapes, because the scaffold is no longer one fixed file list: a repo
 * with a data layer and outbound integrations earns two extra docs, and a bare
 * one does not. Both have to be a connected graph — the conditional docs are
 * exactly the ones a README could forget to link.
 */
const RICH = {
  files: [
    'src/main.ts',
    'src/db/schema.ts',
    'src/orders/orders.service.ts',
    'src/orders/orders.service.test.ts',
    'migrations/0001_init.sql',
    '.github/workflows/ci.yml',
    'docker-compose.yml',
    '.env.example',
  ],
  samples: [
    {
      path: 'package.json',
      content: JSON.stringify({
        name: 'widgets',
        scripts: { test: 'vitest run', dev: 'nest start --watch' },
        dependencies: { '@nestjs/core': '^11.0.0', 'drizzle-orm': '^0.38.3', stripe: '^17.0.0' },
      }),
    },
    { path: 'src/db/schema.ts', content: "export const widgets = pgTable('widgets', {});" },
    {
      path: 'docker-compose.yml',
      content: 'services:\n  db:\n    image: postgres:17\n    ports:\n      - "5433:5432"\n',
    },
    { path: '.env.example', content: '# the database\nDATABASE_URL=postgres://localhost\nSTRIPE_API_KEY=\n' },
    {
      path: '.github/workflows/ci.yml',
      content: 'name: CI\non:\n  push:\njobs:\n  verify:\n    steps:\n      - run: pnpm test\n',
    },
  ],
};

const BARE = { files: ['src/main.ts', 'README.md'], samples: [] };

function scaffoldFor(
  input: { files: string[]; samples: { path: string; content: string }[] },
  drafted?: Parameters<typeof renderScaffold>[0]['drafted'],
) {
  return renderScaffold({
    repoName: 'acme/widgets',
    projectName: 'Widgets',
    isPrimary: true,
    stack,
    evidence: collectEvidence(input),
    date: '2026-08-10',
    agentsMd: '# Working agreements\n',
    drafted,
  });
}

interface Edge {
  from: string;
  to: string | null;
  raw: string;
}

interface Graph {
  docs: ResolvableDoc[];
  edges: Edge[];
}

function graphOf(scaffold: { path: string; content: string }[]): Graph {
  /** Only knowledge/ markdown is indexed; AGENTS.md and CLAUDE.md are not. */
  const docs: ResolvableDoc[] = scaffold
    .filter((f) => f.path.startsWith('knowledge/') && f.path.endsWith('.md'))
    .map((f) => ({ id: f.path, path: f.path }));

  const contentOf = (path: string) => scaffold.find((f) => f.path === path)!.content;

  const edges = docs.flatMap((doc) =>
    extractLinks(contentOf(doc.path))
      // A `coderef` points at the target repo's source, which resolves against
      // the indexed file tree rather than against these docs — the scaffold
      // naming a real entry point is correct, not a broken link.
      .filter((link) => link.kind !== 'coderef')
      .map((link) => {
        const target =
          link.kind === 'wikilink'
            ? resolveWikiStem(link.rawTarget, docs)
            : resolvePathTarget(link.rawTarget, doc.path, docs);
        return { from: doc.path, to: target?.docId ?? null, raw: link.rawTarget };
      }),
  );

  return { docs, edges };
}

describe.each([
  ['a repo with data and integrations', graphOf(scaffoldFor(RICH)), 10],
  ['a repo with neither', graphOf(scaffoldFor(BARE)), 8],
])('the generated knowledge scaffold for %s', (_name, graph, minimumDocs) => {
  const { docs, edges } = graph;

  it('ships the docs that shape earns', () => {
    // Guards the fixture itself: an empty scaffold would pass everything below.
    expect(docs.length).toBeGreaterThanOrEqual(minimumDocs);
  });

  it('produces links the extractor can actually see', () => {
    expect(edges.length).toBeGreaterThan(0);
  });

  it('resolves every link it emits', () => {
    // A scaffold that ships broken links hands the new user a health warning
    // about docs they have not written yet.
    const broken = edges.filter((e) => e.to === null).map((e) => `${e.from} → ${e.raw}`);
    expect(broken).toEqual([]);
  });

  it('leaves no doc orphaned', () => {
    const linked = new Set(edges.map((e) => e.to).filter((id): id is string => id !== null));
    const orphans = docs.map((d) => d.path).filter((path) => !linked.has(path));
    expect(orphans).toEqual([]);
  });

  it('reaches every doc from the README by following links', () => {
    // Stronger than "no orphans": two docs pointing only at each other are
    // both non-orphans and both unreachable from where a reader starts.
    const out = new Map<string, string[]>();
    for (const edge of edges) {
      if (!edge.to) continue;
      out.set(edge.from, [...(out.get(edge.from) ?? []), edge.to]);
    }

    const seen = new Set(['knowledge/README.md']);
    const queue = ['knowledge/README.md'];
    while (queue.length > 0) {
      for (const next of out.get(queue.shift()!) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }

    const unreachable = docs.map((d) => d.path).filter((path) => !seen.has(path));
    expect(unreachable).toEqual([]);
  });
});

describe('paths that point outside knowledge/', () => {
  it('cites a repo doc without turning it into a knowledge-graph edge', () => {
    // The scan hands back real repo paths — a glossary term's `seenIn`, a CI
    // file, a compose file. Rendered in backticks, any of them ending in `.md`
    // is extracted as a doc reference (BACKTICK_PATH) and resolves against
    // knowledge/ only, so `docs/runners.md` becomes a permanent broken edge
    // and the new user's first health report blames docs they never wrote.
    const scaffold = scaffoldFor(RICH, {
      glossaryTerms: [
        { term: 'Runner', meaning: 'A paired daemon that claims jobs.', seenIn: 'docs/runners.md' },
      ],
    });

    const glossary = scaffold.find((f) => f.path === 'knowledge/glossary.md')!.content;
    expect(glossary).toContain('docs/runners.md');
    expect(glossary).not.toContain('`docs/runners.md`');

    const { edges } = graphOf(scaffold);
    expect(edges.filter((e) => e.to === null)).toEqual([]);
  });
});

describe('the scaffold in the two shapes', () => {
  it('emits the data and integration docs only when the scan found something', () => {
    const rich = scaffoldFor(RICH).map((f) => f.path);
    const bare = scaffoldFor(BARE).map((f) => f.path);

    expect(rich).toContain('knowledge/data-model.md');
    expect(rich).toContain('knowledge/integrations.md');
    expect(bare).not.toContain('knowledge/data-model.md');
    expect(bare).not.toContain('knowledge/integrations.md');
  });

  it('writes what it read into the docs, unmarked', () => {
    const scaffold = scaffoldFor(RICH);
    const contentOf = (path: string) => scaffold.find((f) => f.path === path)!.content;

    // Facts, quoted from the files they came from — not claims to be reviewed.
    expect(contentOf('knowledge/conventions.md')).toContain('pnpm test');
    expect(contentOf('knowledge/runbooks/local-dev.md')).toContain('DATABASE_URL');
    expect(contentOf('knowledge/architecture.md')).toContain('postgres:17');
    expect(contentOf('knowledge/data-model.md')).toContain('widgets');
    expect(contentOf('knowledge/integrations.md')).toContain('Stripe');
  });
});
