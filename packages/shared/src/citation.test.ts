import { describe, expect, it } from 'vitest';
import { citationDrift } from './citation.js';
import type { CitationCoverage, RetrievedChunk } from './types.js';

const chunk = (path: string, heading: string | null): RetrievedChunk => ({
  docId: path,
  repoName: 'test/kb',
  path,
  heading,
  text: 'Some prose.',
  score: 1,
  via: 'both',
});

const coverage = (over: Partial<CitationCoverage> = {}): CitationCoverage => ({
  knownPaths: ['knowledge/architecture.md', 'knowledge/testing.md'],
  anchorsByPath: { 'knowledge/architecture.md': ['auth', 'runtime'] },
  unretrievablePaths: [],
  truncatedCount: 0,
  ...over,
});

/**
 * A spec approved on Monday can build on Friday against a knowledge base that
 * merged on Wednesday. The gate is re-checked at the point of use; the evidence
 * never was. This is what notices.
 */
describe('citations that no longer stand', () => {
  it('reports a claim whose cited section has since been deleted', () => {
    const drifted = citationDrift(
      [{ text: 'Auth is JWT.', citation: 'knowledge/architecture.md#auth', verdict: 'supported' }],
      [chunk('knowledge/testing.md', 'top')],
      coverage({ knownPaths: ['knowledge/testing.md'] }),
    );
    expect(drifted).toHaveLength(1);
    expect(drifted[0]).toMatchObject({
      citation: 'knowledge/architecture.md#auth',
      was: 'supported',
      now: 'unsupported',
    });
    expect(drifted[0]!.note).toBeTruthy();
  });

  it('says nothing while the evidence still stands', () => {
    expect(
      citationDrift(
        [{ text: 'Auth is JWT.', citation: 'knowledge/architecture.md#auth', verdict: 'supported' }],
        [chunk('knowledge/architecture.md', 'auth')],
        coverage(),
      ),
    ).toEqual([]);
  });

  it('does not report a claim that got better', () => {
    // Approved as unknown, now retrievable. The reviewer already accepted the
    // weaker state; telling them it improved is noise in a channel that has to
    // stay worth reading.
    expect(
      citationDrift(
        [{ text: 'Auth is JWT.', citation: 'knowledge/architecture.md#auth', verdict: 'unknown' }],
        [chunk('knowledge/architecture.md', 'auth')],
        coverage(),
      ),
    ).toEqual([]);
  });

  it('reports a slide from supported to merely unknown', () => {
    // The doc is real and still indexed; this retrieval just did not surface
    // the section. Worth a look, and explicitly not the same as "wrong".
    const drifted = citationDrift(
      [{ text: 'Auth is JWT.', citation: 'knowledge/architecture.md#auth', verdict: 'supported' }],
      [chunk('knowledge/testing.md', 'top')],
      coverage(),
    );
    expect(drifted).toHaveLength(1);
    expect(drifted[0]!.now).toBe('unknown');
  });

  it('skips claims with no recorded verdict rather than guessing', () => {
    // Specs drafted before verdicts existed would otherwise all read as
    // having drifted, on their first build, forever.
    expect(
      citationDrift(
        [{ text: 'Auth is JWT.', citation: 'knowledge/architecture.md#auth' }],
        [chunk('knowledge/testing.md', 'top')],
        coverage(),
      ),
    ).toEqual([]);
  });

  it('ignores claims that never cited anything', () => {
    expect(
      citationDrift(
        [{ text: 'An UNVERIFIED judgement call.', verdict: 'unsupported' }],
        [chunk('knowledge/architecture.md', 'auth')],
        coverage(),
      ),
    ).toEqual([]);
  });
});
