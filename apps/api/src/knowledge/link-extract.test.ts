import { describe, expect, it } from 'vitest';
import { extractLinks } from './link-extract.js';

/**
 * Deterministic extraction over the four syntaxes that occur in this repo's
 * real knowledge tree. The fixture text below is lifted from actual ADRs.
 */

describe('extractLinks', () => {
  it('extracts all four syntaxes from one document', () => {
    const doc = [
      '# 0010 — Jira via API token',
      '',
      '## Context',
      '',
      'This is the same trade-off [[0002-gitlab-via-personal-access-token]] made.',
      'Per the plan, see [the dogfooding decision](../decisions/0011-specd-develops-specd.md).',
      '',
      '## Decision',
      '',
      'The reasoning per knowledge/decisions/0003-runner-pairing-before-dispatch.md#context holds.',
      'Details live in `decisions/0008-remove-unused-queue.md` as well.',
    ].join('\n');

    const links = extractLinks(doc);
    const byKind = Object.fromEntries(
      ['wikilink', 'citation', 'mdlink', 'pathref'].map((k) => [k, links.filter((l) => l.kind === k)]),
    );

    expect(byKind.wikilink).toHaveLength(1);
    expect(byKind.wikilink![0]).toMatchObject({
      rawTarget: '0002-gitlab-via-personal-access-token',
      site: 'context',
    });

    expect(byKind.citation).toHaveLength(1);
    expect(byKind.citation![0]).toMatchObject({
      rawTarget: 'knowledge/decisions/0003-runner-pairing-before-dispatch.md',
      anchor: 'context',
      site: 'decision',
    });

    expect(byKind.mdlink).toHaveLength(1);
    expect(byKind.mdlink![0]!.rawTarget).toBe('../decisions/0011-specd-develops-specd.md');

    expect(byKind.pathref).toHaveLength(1);
    expect(byKind.pathref![0]!.rawTarget).toBe('decisions/0008-remove-unused-queue.md');
  });

  it('tracks the site as the nearest heading above the link', () => {
    const doc = '# Top\n\nintro [[a-doc]]\n\n## Later section\n\nbody [[b-doc]]\n';
    const links = extractLinks(doc);
    expect(links.find((l) => l.rawTarget === 'a-doc')?.site).toBe('top');
    expect(links.find((l) => l.rawTarget === 'b-doc')?.site).toBe('later-section');
  });

  it('does not double-report a citation path as a bare path mention', () => {
    const doc = 'Held per knowledge/decisions/0004-runner-job-dispatch.md#decision today.';
    const links = extractLinks(doc);
    expect(links).toHaveLength(1);
    expect(links[0]!.kind).toBe('citation');
  });

  it('ignores everything inside fenced code blocks — examples are not claims', () => {
    const doc = [
      'Real link: [[0004-runner-job-dispatch]]',
      '```',
      'knowledge/specs/EXAMPLE-1-not-real.md',
      '[[not-a-link]]',
      '```',
      'after',
    ].join('\n');
    const links = extractLinks(doc);
    expect(links).toHaveLength(1);
    expect(links[0]!.rawTarget).toBe('0004-runner-job-dispatch');
  });

  it('dedupes an identical link repeated under the same heading', () => {
    const doc = '## One\n\n[[same-doc]] and again [[same-doc]]\n';
    expect(extractLinks(doc)).toHaveLength(1);
  });

  it('keeps the same link when it recurs under a different heading — different site, different edge', () => {
    const doc = '## One\n\n[[same-doc]]\n\n## Two\n\n[[same-doc]]\n';
    expect(extractLinks(doc)).toHaveLength(2);
  });

  it('extracts nothing from a plain doc', () => {
    expect(extractLinks('# Title\n\nJust prose, no references at all.\n')).toHaveLength(0);
  });
});
