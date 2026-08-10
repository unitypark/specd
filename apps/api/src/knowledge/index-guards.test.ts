import { describe, expect, it } from 'vitest';
import type { DbContext } from '@specd/db';
import { assertNoUnexplainedEdgeLoss, assertNoUnexplainedShrink } from './knowledge.service.js';

/**
 * The two guards that stand between a bad index run and a gutted knowledge
 * base. They are unit-tested apart from the pipeline on purpose: each one has
 * to hold for inputs the pipeline cannot easily be talked into producing.
 */

describe('assertNoUnexplainedShrink', () => {
  it('allows a run that removes nothing', () => {
    expect(() => assertNoUnexplainedShrink(10, 0, 10, 'acme/kb')).not.toThrow();
  });

  it('allows ordinary maintenance deletions', () => {
    expect(() => assertNoUnexplainedShrink(20, 3, 17, 'acme/kb')).not.toThrow();
    expect(() => assertNoUnexplainedShrink(20, 9, 11, 'acme/kb')).not.toThrow();
  });

  it('refuses to remove more than half of a repo at once', () => {
    expect(() => assertNoUnexplainedShrink(20, 11, 9, 'acme/kb')).toThrow(/Refusing to re-index/);
  });

  it('refuses an empty listing however small the repo', () => {
    // The case the count floor alone let through: every doc in a three-doc
    // repo disappearing at once. An empty listing and a deleted directory are
    // indistinguishable from here, and only one of them should erase an index.
    expect(() => assertNoUnexplainedShrink(3, 3, 0, 'acme/kb')).toThrow(/listed none at all/);
    expect(() => assertNoUnexplainedShrink(1, 1, 0, 'acme/kb')).toThrow(/Refusing to re-index/);
  });

  it('allows an empty listing when the index is empty too', () => {
    // A repo with no knowledge/ directory is not a repo that lost one.
    expect(() => assertNoUnexplainedShrink(0, 0, 0, 'acme/kb')).not.toThrow();
  });
});

describe('assertNoUnexplainedEdgeLoss', () => {
  /** A context whose only job is to answer the guard's one grouped count. */
  const ctxReturning = (after: Record<string, number>): DbContext =>
    ({
      db: {} as never,
      sql: (() =>
        Promise.resolve(
          Object.entries(after).map(([source_doc_id, n]) => ({ source_doc_id, n })),
        )) as never,
    }) as DbContext;

  const before = new Map([
    ['doc-a', 3],
    ['doc-b', 2],
  ]);

  it('passes when nothing lost edges', async () => {
    await expect(
      assertNoUnexplainedEdgeLoss(
        ctxReturning({ 'doc-a': 3, 'doc-b': 2 }),
        'p1',
        before,
        new Set(),
        'acme/kb',
      ),
    ).resolves.toBeUndefined();
  });

  it('passes when the doc that lost edges was re-indexed this run', async () => {
    await expect(
      assertNoUnexplainedEdgeLoss(
        ctxReturning({ 'doc-a': 1, 'doc-b': 2 }),
        'p1',
        before,
        new Set(['doc-a']),
        'acme/kb',
      ),
    ).resolves.toBeUndefined();
  });

  it('passes when the doc that lost every edge was deleted this run', async () => {
    await expect(
      assertNoUnexplainedEdgeLoss(
        ctxReturning({ 'doc-b': 2 }),
        'p1',
        before,
        new Set(['doc-a']),
        'acme/kb',
      ),
    ).resolves.toBeUndefined();
  });

  it('passes when a doc gained edges', async () => {
    await expect(
      assertNoUnexplainedEdgeLoss(
        ctxReturning({ 'doc-a': 9, 'doc-b': 2 }),
        'p1',
        before,
        new Set(),
        'acme/kb',
      ),
    ).resolves.toBeUndefined();
  });

  it('refuses when a doc nobody touched lost edges', async () => {
    // The failure this exists to catch: a stray delete or an unintended
    // cascade taking edges out from under a doc the run never looked at.
    await expect(
      assertNoUnexplainedEdgeLoss(
        ctxReturning({ 'doc-a': 3 }),
        'p1',
        before,
        new Set(['doc-a']),
        'acme/kb',
      ),
    ).rejects.toThrow(/would drop 2 link\(s\) from 1 doc\(s\) it never re-indexed or deleted/);
  });
});
