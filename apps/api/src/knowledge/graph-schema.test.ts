import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  EDGE_WEIGHT,
  LINK_KINDS,
  RESOLUTION_STATES,
  VOCABULARY_BEGIN,
  VOCABULARY_END,
  renderGraphVocabulary,
} from './graph-schema.js';
import { headingAnchor } from './chunker.js';
import { anchorOf } from './link-resolve.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('graph vocabulary', () => {
  it('gives every kind a weight without a fallback', () => {
    // The fallback was the bug: a fifth kind would silently expand at 0.3 and
    // nothing would say so. Derivation makes that a type error instead.
    for (const spec of LINK_KINDS) {
      expect(EDGE_WEIGHT[spec.kind]).toBe(spec.weight);
    }
    expect(Object.keys(EDGE_WEIGHT).sort()).toEqual(LINK_KINDS.map((k) => k.kind).sort());
  });

  it('orders authored intent above incidental mention', () => {
    // The ordering is the design claim; the absolute numbers are not.
    const weight = (kind: string) => LINK_KINDS.find((k) => k.kind === kind)!.weight;
    expect(weight('citation')).toBeGreaterThan(weight('wikilink'));
    expect(weight('wikilink')).toBeGreaterThan(weight('mdlink'));
    expect(weight('mdlink')).toBeGreaterThan(weight('pathref'));
  });

  it('keeps knowledge/architecture.md in step with the code', () => {
    // The docs consumer. Nothing stops someone editing the table by hand, so
    // this is what notices — the same anti-drift check the benchmarked engine
    // uses for its generated sections, and the absence of which is exactly
    // where its own docs drifted.
    const doc = readFileSync(resolve(repoRoot, 'knowledge/architecture.md'), 'utf8');
    const begin = doc.indexOf(VOCABULARY_BEGIN);
    const end = doc.indexOf(VOCABULARY_END);
    expect(begin, 'generated vocabulary section is missing').toBeGreaterThan(-1);

    const inDoc = doc.slice(begin, end + VOCABULARY_END.length);
    expect(inDoc).toBe(renderGraphVocabulary());
  });

  it('documents every kind and state it declares', () => {
    const rendered = renderGraphVocabulary();
    for (const spec of LINK_KINDS) expect(rendered).toContain(`\`${spec.kind}\``);
    for (const state of RESOLUTION_STATES) expect(rendered).toContain(`\`${state}\``);
  });
});

describe('one anchor recipe', () => {
  /**
   * S-102 mandated a single shared normalize module and two grew anyway: the
   * chunker slugified `[^a-z0-9]+` while the resolver kept unicode letters.
   * Harmless until citation checking began comparing a chunk's anchor against
   * a doc's real headings — at which point the disagreement started reporting
   * sound citations as unchecked.
   */
  it('agrees with the resolver on anything outside ASCII', () => {
    for (const heading of ['Café notes', 'Ärchitecture', '日本語', 'Auth flow', 'Data & Storage!']) {
      expect(headingAnchor(heading)).toBe(anchorOf(heading) || null);
    }
  });

  it('no longer erases a heading that has no ASCII in it', () => {
    // The old recipe returned '' here, so the chunk had no citable anchor at
    // all while the resolver happily recorded one.
    expect(headingAnchor('日本語')).toBe('日本語');
    expect(headingAnchor('Café notes')).toBe('café-notes');
  });

  it('still handles the plain cases the chunker always did', () => {
    expect(headingAnchor('Auth flow')).toBe('auth-flow');
    expect(headingAnchor('Data & Storage!')).toBe('data-storage');
    expect(headingAnchor(null)).toBeNull();
  });
});
