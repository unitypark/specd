import { describe, expect, it } from 'vitest';
import { renderScaffold, type DetectedStack } from '@specd/templates';
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

const scaffold = renderScaffold({
  repoName: 'acme/widgets',
  projectName: 'Widgets',
  isPrimary: true,
  stack,
  topLevelDirs: ['src', 'test'],
  entryPoints: ['src/main.ts'],
  glossaryTerms: ['Widget'],
  date: '2026-08-10',
  agentsMd: '# Working agreements\n',
});

/** Only knowledge/ markdown is indexed; AGENTS.md and CLAUDE.md are not. */
const docs: ResolvableDoc[] = scaffold
  .filter((f) => f.path.startsWith('knowledge/') && f.path.endsWith('.md'))
  .map((f) => ({ id: f.path, path: f.path }));

const contentOf = (path: string) => scaffold.find((f) => f.path === path)!.content;

interface Edge {
  from: string;
  to: string | null;
  raw: string;
}

const edges: Edge[] = docs.flatMap((doc) =>
  extractLinks(contentOf(doc.path)).map((link) => {
    const target =
      link.kind === 'wikilink'
        ? resolveWikiStem(link.rawTarget, docs)
        : resolvePathTarget(link.rawTarget, doc.path, docs);
    return { from: doc.path, to: target?.docId ?? null, raw: link.rawTarget };
  }),
);

describe('the generated knowledge scaffold', () => {
  it('ships more than one doc', () => {
    // Guards the fixture itself: an empty scaffold would pass everything below.
    expect(docs.length).toBeGreaterThan(5);
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
