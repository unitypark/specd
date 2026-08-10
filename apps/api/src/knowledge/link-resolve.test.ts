import { describe, expect, it } from 'vitest';
import {
  anchorOf,
  headingAnchorsOf,
  normalizeStem,
  pathStem,
  resolvePathTarget,
  resolveWikiStem,
} from './link-resolve.js';

/**
 * The one shared resolve recipe (S-102). These fixtures are the link shapes
 * that actually occur in this repository's knowledge tree — measured before
 * the feature was specced, not invented for the test.
 */

const DOCS = [
  { id: 'd1', path: 'knowledge/decisions/0004-runner-job-dispatch.md' },
  { id: 'd2', path: 'knowledge/decisions/0009-build-dispatch-runner-git-credentials.md' },
  { id: 'd3', path: 'knowledge/specs/S-104-improve-cli-app-like-claude-code-or-copilot.md' },
  { id: 'd4', path: 'knowledge/architecture.md' },
  { id: 'd5', path: 'knowledge/runbooks/specd-on-specd.md' },
];

describe('normalizeStem', () => {
  it('is idempotent — the contract every producer relies on', () => {
    for (const input of ['0004-Runner Job—Dispatch.md', 'S-104', 'Ärchitecture Décisions', 'a__b--c']) {
      const once = normalizeStem(input);
      expect(normalizeStem(once)).toBe(once);
    }
  });

  it('folds case, unicode form and punctuation runs', () => {
    expect(normalizeStem('0004-Runner_Job Dispatch')).toBe('0004-runner-job-dispatch');
    expect(normalizeStem('Ｓ-104')).toBe('s-104'); // fullwidth S via NFKC
  });
});

describe('resolveWikiStem', () => {
  it('resolves a full decision stem, the dominant real usage', () => {
    expect(resolveWikiStem('0004-runner-job-dispatch', DOCS)?.id ?? null).toBeNull;
    expect(resolveWikiStem('0004-runner-job-dispatch', DOCS)?.docId).toBe('d1');
  });

  it('resolves a spec id prefix — [[S-104]] finds the as-built file', () => {
    expect(resolveWikiStem('S-104', DOCS)?.docId).toBe('d3');
  });

  it('refuses an ambiguous prefix rather than picking a winner', () => {
    const docs = [
      ...DOCS,
      { id: 'dx', path: 'knowledge/specs/S-104-second-spec-with-same-prefix.md' },
    ];
    expect(resolveWikiStem('S-104', docs)).toBeNull();
  });

  it('returns null for an unknown stem — flag, don\'t guess', () => {
    expect(resolveWikiStem('0099-never-written', DOCS)).toBeNull();
    expect(resolveWikiStem('', DOCS)).toBeNull();
  });
});

describe('resolvePathTarget', () => {
  const from = 'knowledge/decisions/0009-build-dispatch-runner-git-credentials.md';

  it('resolves a knowledge-rooted citation path', () => {
    expect(resolvePathTarget('knowledge/decisions/0004-runner-job-dispatch.md', from, DOCS)?.docId).toBe('d1');
  });

  it('resolves a ../ relative markdown link from the source doc', () => {
    expect(resolvePathTarget('../architecture.md', from, DOCS)?.docId).toBe('d4');
    expect(resolvePathTarget('../runbooks/specd-on-specd.md', from, DOCS)?.docId).toBe('d5');
  });

  it('resolves a tree-relative backticked path', () => {
    expect(resolvePathTarget('decisions/0004-runner-job-dispatch.md', 'knowledge/README.md', DOCS)?.docId).toBe('d1');
  });

  it('ignores external URLs and unknown paths', () => {
    expect(resolvePathTarget('https://example.com/x.md', from, DOCS)).toBeNull();
    expect(resolvePathTarget('knowledge/never/was.md', from, DOCS)).toBeNull();
  });
});

describe('anchors', () => {
  it('derives the same anchor form citations use', () => {
    expect(anchorOf('Why this rather than minting tokens')).toBe('why-this-rather-than-minting-tokens');
  });

  it('collects heading anchors, skipping fenced pseudo-headings', () => {
    const anchors = headingAnchorsOf('# Title\n\n## Decision\n```\n# not a heading\n```\n## Consequences\n');
    expect(anchors.has('decision')).toBe(true);
    expect(anchors.has('consequences')).toBe(true);
    expect(anchors.has('not-a-heading')).toBe(false);
  });
});
