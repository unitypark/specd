import { describe, it, expect } from 'vitest';
import { DOCS, PAGES, findPage, neighbours } from './index';
import { anchor, headingText, inline, outline, type Block } from './types';

/*
 * The docs corpus is data, and data can be wrong in ways a type cannot catch:
 * a link to a page that was renamed, two headings that collapse to the same
 * anchor, a page nobody can reach. Those failures are invisible in review and
 * obvious in production, which is exactly the shape a test is for.
 *
 * These assertions also protect the *published* site: `scripts/site/build.ts`
 * renders the same corpus, so a dead `/docs/...` link here is a 404 there.
 */

const KNOWN_BLOCK_KINDS = new Set([
  'p',
  'lead',
  'h2',
  'h3',
  'ul',
  'ol',
  'dl',
  'code',
  'table',
  'note',
  'steps',
  'cards',
  'quote',
]);

/** Every string in the corpus that inline markup can appear in. */
function textsOf(b: Block): string[] {
  switch (b.k) {
    case 'p':
    case 'lead':
    case 'h2':
    case 'h3':
      return [b.text];
    case 'ul':
    case 'ol':
      return b.items;
    case 'dl':
      return b.items.flatMap((i) => [i.term, i.text]);
    case 'table':
      return [...b.head, ...b.rows.flat()];
    case 'note':
      return [b.text, ...(b.title ? [b.title] : [])];
    case 'steps':
      return b.items.flatMap((i) => [i.title, i.text]);
    case 'cards':
      return b.items.flatMap((i) => [i.title, i.text]);
    case 'quote':
      return [b.text, ...(b.cite ? [b.cite] : [])];
    case 'code':
      // Deliberately excluded: a code sample is verbatim, and backticks or
      // brackets inside it are the sample, not markup.
      return [];
  }
}

describe('the docs corpus', () => {
  it('has a unique slug for every page', () => {
    const slugs = PAGES.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('uses url-safe slugs', () => {
    for (const p of PAGES) expect(p.slug, p.title).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('gives every page a title, a summary and a reading time', () => {
    for (const p of PAGES) {
      expect(p.title.length, p.slug).toBeGreaterThan(0);
      expect(p.summary.length, p.slug).toBeGreaterThan(20);
      expect(p.minutes, p.slug).toBeGreaterThan(0);
    }
  });

  it('only uses block kinds both renderers know', () => {
    for (const p of PAGES) {
      for (const b of p.blocks) expect(KNOWN_BLOCK_KINDS, `${p.slug}: ${b.k}`).toContain(b.k);
    }
  });

  it('keeps table rows the same width as their header', () => {
    for (const p of PAGES) {
      for (const b of p.blocks) {
        if (b.k !== 'table') continue;
        for (const row of b.rows) expect(row.length, `${p.slug} · ${b.head[0]}`).toBe(b.head.length);
      }
    }
  });

  it('never collides two headings on one page', () => {
    for (const p of PAGES) {
      const ids = p.blocks
        .filter((b): b is Extract<Block, { k: 'h2' | 'h3' }> => b.k === 'h2' || b.k === 'h3')
        .map((b) => anchor(headingText(b.text)));
      expect(new Set(ids).size, p.slug).toBe(ids.length);
    }
  });

  it('never leaves an inline marker visible in a heading', () => {
    // Headings are stripped rather than marked up (see headingText), so a
    // heading carrying a link would silently lose it.
    for (const p of PAGES) {
      for (const b of p.blocks) {
        if (b.k !== 'h2' && b.k !== 'h3') continue;
        expect(headingText(b.text), `${p.slug}: ${b.text}`).not.toMatch(/[`*_]|\]\(/);
      }
    }
  });

  it('resolves every internal /docs link to a real page', () => {
    const bad: string[] = [];
    for (const p of PAGES) {
      for (const b of p.blocks) {
        const hrefs = [
          ...textsOf(b).flatMap((t) => inline(t).filter((x) => x.t === 'link').map((x) => x.href)),
          ...(b.k === 'cards' ? b.items.map((i) => i.href).filter((h): h is string => !!h) : []),
        ];
        for (const href of hrefs) {
          if (!href.startsWith('/docs/')) continue;
          if (!findPage(href.slice('/docs/'.length))) bad.push(`${p.slug} → ${href}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('points every link at something', () => {
    for (const p of PAGES) {
      for (const b of p.blocks) {
        for (const t of textsOf(b).flatMap(inline)) {
          if (t.t === 'link') expect(t.href.length, `${p.slug}: ${t.v}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('opens every page with a lead paragraph or a heading', () => {
    for (const p of PAGES) {
      expect(['lead', 'h2'], p.slug).toContain(p.blocks[0]?.k);
    }
  });

  it('chains prev/next across the whole corpus', () => {
    expect(neighbours(PAGES[0].slug).prev).toBeUndefined();
    expect(neighbours(PAGES[PAGES.length - 1].slug).next).toBeUndefined();
    // Walking `next` from the first page must reach the last one — otherwise a
    // reader following the pager falls off the end early.
    let walked = 1;
    for (let cur = PAGES[0]; ; walked++) {
      const nxt = neighbours(cur.slug).next;
      if (!nxt) break;
      cur = nxt;
    }
    expect(walked).toBe(PAGES.length);
  });

  it('gives categories at least one page each', () => {
    for (const c of DOCS) expect(c.pages.length, c.title).toBeGreaterThan(0);
  });
});

describe('inline()', () => {
  it('parses the four markers', () => {
    expect(inline('a `b` **c** [d](/e) _f_')).toEqual([
      { t: 'text', v: 'a ' },
      { t: 'code', v: 'b' },
      { t: 'text', v: ' ' },
      { t: 'strong', v: 'c' },
      { t: 'text', v: ' ' },
      { t: 'link', v: 'd', href: '/e' },
      { t: 'text', v: ' ' },
      { t: 'em', v: 'f' },
    ]);
  });

  it('leaves plain text alone', () => {
    expect(inline('nothing to see')).toEqual([{ t: 'text', v: 'nothing to see' }]);
  });

  it('is reusable — the shared regex does not carry state between calls', () => {
    const once = inline('`a` and `b`');
    expect(inline('`a` and `b`')).toEqual(once);
  });
});

describe('anchor() and outline()', () => {
  it('slugifies heading text', () => {
    expect(anchor('The four verdicts — and why')).toBe('the-four-verdicts-and-why');
  });

  it('lists only h2s, in order', () => {
    const page = findPage('the-pipeline')!;
    const ids = outline(page).map((h) => h.id);
    expect(ids.length).toBeGreaterThan(3);
    expect(ids).toContain('01-connect');
  });
});
