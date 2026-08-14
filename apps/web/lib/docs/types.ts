/*
 * The documentation content model.
 *
 * Docs are data, not JSX, for one reason: they are rendered twice. The Next
 * app renders them at /docs with the product's own chrome, and
 * `scripts/site/build.ts` renders the *same* pages into static HTML for the
 * GitHub Pages site — which is the only place a visitor who has not cloned
 * the repo can read them. Two renderers over one source is the only shape
 * where the published docs cannot drift from the in-app docs; a second copy
 * written in HTML would be stale within a week.
 *
 * Deliberately a small block vocabulary rather than markdown. A markdown
 * pipeline means a parser dependency in the web app and a second one in a
 * build script, and it buys expressiveness the docs do not need. What they
 * do need — a comparison table, a callout with a tone, a numbered walkthrough
 * — are first-class here and would be raw HTML in markdown anyway.
 *
 * IMPORTANT: nothing in `lib/docs/` may import from outside it. The static
 * site generator loads these modules through tsx with no bundler, no path
 * aliases and no React, so an `@/components/...` import would break the
 * published site while leaving the app perfectly green.
 */

/** Callout flavours. `rule` is for the invariants specd enforces in code. */
export type Tone = 'info' | 'warn' | 'good' | 'rule';

export type Block =
  /** Body copy. Supports the inline syntax below. */
  | { k: 'p'; text: string }
  /** The one-sentence answer to the page's question, set larger. */
  | { k: 'lead'; text: string }
  /** Section heading. Anchors and the "on this page" rail are derived from these. */
  | { k: 'h2'; text: string }
  | { k: 'h3'; text: string }
  | { k: 'ul'; items: string[] }
  | { k: 'ol'; items: string[] }
  /** Term/definition rows — the shape most reference material actually is. */
  | { k: 'dl'; items: { term: string; text: string }[] }
  | { k: 'code'; caption?: string; code: string }
  | { k: 'table'; head: string[]; rows: string[][] }
  | { k: 'note'; tone: Tone; title?: string; text: string }
  /** A numbered walkthrough where each step has a name worth reading alone. */
  | { k: 'steps'; items: { title: string; text: string }[] }
  /** Navigational tiles — used at the end of a page and on the docs home. */
  | { k: 'cards'; items: { title: string; text: string; href?: string }[] }
  /** A claim worth pulling out of the flow. */
  | { k: 'quote'; text: string; cite?: string };

/** Who a page is written for. Rendered as a chip, and filterable by eye. */
export type Audience = 'everyone' | 'engineering' | 'leadership';

export interface DocPage {
  /** URL segment. `/docs/<slug>` in the app, `/docs/<slug>/` on the site. */
  slug: string;
  title: string;
  /** Shown under the title, and as the meta description. */
  summary: string;
  audience: Audience;
  /** Honest reading time, rounded up. Not computed — a count would rot. */
  minutes: number;
  blocks: Block[];
}

export interface DocCategory {
  title: string;
  /** One line explaining what the whole category answers. */
  blurb: string;
  pages: DocPage[];
}

/* ── inline syntax ───────────────────────────────────────────────────────── */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong'; v: string }
  | { t: 'em'; v: string }
  | { t: 'link'; v: string; href: string };

const INLINE_RE = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)|_([^_]+)_/g;

/**
 * Parse the four inline markers into tokens: `` `code` ``, `**strong**`,
 * `[label](href)` and `_emphasis_`.
 *
 * Returns tokens rather than a string so the React renderer and the HTML
 * renderer share the parse and differ only in what they build from it —
 * which is also what keeps the HTML one from having to escape a string that
 * already contains markup.
 */
export function inline(src: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  INLINE_RE.lastIndex = 0;
  for (let m = INLINE_RE.exec(src); m; m = INLINE_RE.exec(src)) {
    if (m.index > last) out.push({ t: 'text', v: src.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ t: 'code', v: m[1] });
    else if (m[2] !== undefined) out.push({ t: 'strong', v: m[2] });
    // Both halves of the link alternation always capture together, but the
    // guard is written out rather than asserted: this module is typechecked
    // under `noUncheckedIndexedAccess` by scripts/site/tsconfig.json, and a
    // non-null assertion would just move the risk somewhere unreadable.
    else if (m[3] !== undefined && m[4] !== undefined)
      out.push({ t: 'link', v: m[3], href: m[4] });
    else if (m[5] !== undefined) out.push({ t: 'em', v: m[5] });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ t: 'text', v: src.slice(last) });
  return out;
}

/** The same string with its markers removed — for `<title>`, meta
 *  descriptions and anywhere else that takes text but not markup. */
export function plain(src: string): string {
  return inline(src)
    .map((t) => t.v)
    .join('');
}

/* ── headings ────────────────────────────────────────────────────────────── */

/** Stable anchor for a heading. Two headings with the same text collide, and
 *  the "on this page" test asserts that never happens on a page. */
export function anchor(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Heading text as it is rendered and anchored.
 *
 * Headings are written in the same inline syntax as everything else, but they
 * are set in the display face and appear again in the contents rail and in an
 * anchor — three places a `<code>` chip would have to be styled to match. So
 * a heading's markers are stripped rather than rendered: `` `UNVERIFIED` is a
 * feature`` sets as "UNVERIFIED is a feature", and both renderers and the
 * rail agree because all three go through here.
 */
export function headingText(text: string): string {
  return plain(text);
}

/** The h2s of a page, in order — the right-hand rail's contents. */
export function outline(page: DocPage): { id: string; text: string }[] {
  return page.blocks
    .filter((b): b is Extract<Block, { k: 'h2' }> => b.k === 'h2')
    .map((b) => ({ id: anchor(headingText(b.text)), text: headingText(b.text) }));
}
