/*
 * Blocks → HTML.
 *
 * The second of the two renderers over `apps/web/lib/docs`; the first is
 * `apps/web/components/DocBlocks.tsx`. Both walk the same block union, so a
 * page reads identically in the app and on the published site, and a new block
 * kind that only one of them knows fails `lib/docs/docs.test.ts` rather than
 * silently vanishing from the public copy.
 *
 * Every URL this file emits is relative. GitHub Pages serves a project site
 * from a sub-path (`/specd/`), and relative links are the only kind that work
 * there, under a custom domain, and in a local `file://` preview without a
 * base-path setting to keep in sync.
 */

import {
  DOCS,
  anchor,
  headingText,
  inline,
  outline,
  plain,
  type Block,
  type DocCategory,
  type DocPage,
} from '../../apps/web/lib/docs/index';

export { DOCS, PAGES, outline, plain } from '../../apps/web/lib/docs/index';
export type { DocCategory, DocPage } from '../../apps/web/lib/docs/index';

/** How many levels below the site root a page sits: '' , '../' , '../../'. */
export type Up = string;

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Rewrite an authored href for the static site. */
function href(raw: string, up: Up): string {
  if (raw.startsWith('/docs/')) return `${up}docs/${raw.slice('/docs/'.length)}/`;
  if (raw === '/docs') return `${up}docs/`;
  // An app-only route (there is no hosted app) — send the reader to the docs
  // rather than to a 404.
  if (raw.startsWith('/')) return `${up}docs/`;
  return raw;
}

function external(raw: string): boolean {
  return /^[a-z]+:/i.test(raw);
}

export function renderInline(src: string, up: Up): string {
  return inline(src)
    .map((t) => {
      switch (t.t) {
        case 'code':
          return `<code>${esc(t.v)}</code>`;
        case 'strong':
          return `<strong>${esc(t.v)}</strong>`;
        case 'em':
          return `<em>${esc(t.v)}</em>`;
        case 'link': {
          const rel = external(t.href) ? ' target="_blank" rel="noreferrer noopener"' : '';
          return `<a href="${esc(href(t.href, up))}"${rel}>${esc(t.v)}</a>`;
        }
        default:
          return esc(t.v);
      }
    })
    .join('');
}

function block(b: Block, up: Up): string {
  const i = (s: string) => renderInline(s, up);
  switch (b.k) {
    case 'lead':
      return `<p class="summary">${i(b.text)}</p>`;
    case 'p':
      return `<p>${i(b.text)}</p>`;
    case 'h2':
      return `<h2 id="${esc(anchor(headingText(b.text)))}">${esc(headingText(b.text))}</h2>`;
    case 'h3':
      return `<h3 id="${esc(anchor(headingText(b.text)))}">${esc(headingText(b.text))}</h3>`;
    case 'ul':
      return `<ul>${b.items.map((it) => `<li>${i(it)}</li>`).join('')}</ul>`;
    case 'ol':
      return `<ol>${b.items.map((it) => `<li>${i(it)}</li>`).join('')}</ol>`;
    case 'dl':
      return `<dl>${b.items
        .map((it) => `<div><dt>${i(it.term)}</dt><dd>${i(it.text)}</dd></div>`)
        .join('')}</dl>`;
    case 'code':
      return `<figure class="code">${
        b.caption ? `<figcaption>${esc(b.caption)}</figcaption>` : ''
      }<pre><code>${esc(b.code)}</code></pre></figure>`;
    case 'table':
      return `<div class="tablewrap"><table><thead><tr>${b.head
        .map((h) => `<th>${i(h)}</th>`)
        .join('')}</tr></thead><tbody>${b.rows
        .map((r) => `<tr>${r.map((c) => `<td>${i(c)}</td>`).join('')}</tr>`)
        .join('')}</tbody></table></div>`;
    case 'note':
      return `<aside class="callout ${b.tone}">${
        b.title ? `<strong class="t">${i(b.title)}</strong>` : ''
      }<p>${i(b.text)}</p></aside>`;
    case 'steps':
      return `<ol class="steps">${b.items
        .map((it) => `<li><h4>${i(it.title)}</h4><p>${i(it.text)}</p></li>`)
        .join('')}</ol>`;
    case 'cards':
      return `<div class="cards">${b.items
        .map((it) => {
          const inner = `<h4>${i(it.title)}</h4><p>${i(it.text)}</p>`;
          return it.href
            ? `<a class="c" href="${esc(href(it.href, up))}">${inner}</a>`
            : `<div class="c">${inner}</div>`;
        })
        .join('')}</div>`;
    case 'quote':
      return `<blockquote class="pull"><p>${i(b.text)}</p>${
        b.cite ? `<cite>${esc(b.cite)}</cite>` : ''
      }</blockquote>`;
  }
}

export function renderBlocks(blocks: Block[], up: Up): string {
  return blocks.map((b) => block(b, up)).join('\n');
}

/* ── chrome ──────────────────────────────────────────────────────────────── */

const REPO = 'https://github.com/unitypark/specd';

/*
 * The mark, inlined so the nav needs no second request — and so it inherits
 * `currentColor`, which is what lets the same markup sit on the dark nav pill
 * and on the light footer. Four rotations of one hook, copied from
 * assets/logo-light.svg (itself extracted from the app's Logo component).
 */
const HOOK = 'M8.48 7.26A8 8 0 1 1 20 16.93';
const MARK =
  `<svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true" fill="none" ` +
  `stroke="currentColor" stroke-width="2.9" stroke-linecap="round">` +
  [0, 90, 180, 270]
    .map((d) => `<path d="${HOOK}"${d ? ` transform="rotate(${d} 16 16)"` : ''}/>`)
    .join('') +
  `</svg>`;

export function nav(up: Up, active: 'home' | 'docs'): string {
  const link = (label: string, to: string, on: boolean) =>
    `<li><a href="${esc(to)}"${on ? ' aria-current="page"' : ''}>${label}</a></li>`;
  return `<header class="nav"><div class="navbar">
  <a class="navbrand" href="${up || './'}">${MARK}<span>spec<i>d</i></span></a>
  <ul class="navlinks">
    ${link('Home', up || './', active === 'home')}
    ${link('Docs', `${up}docs/`, active === 'docs')}
    ${link('Quickstart', `${up}docs/quickstart/`, false)}
    ${link('Architecture', `${up}docs/architecture/`, false)}
    <li><a href="${REPO}" target="_blank" rel="noreferrer noopener">GitHub</a></li>
  </ul>
  <a class="navcta" href="${up}docs/quickstart/">Get started</a>
</div></header>`;
}

export function footer(up: Up): string {
  const col = (title: string, links: [string, string][]) =>
    `<div><h2>${title}</h2><ul>${links
      .map(
        ([l, h]) =>
          `<li><a href="${esc(h)}"${external(h) ? ' target="_blank" rel="noreferrer noopener"' : ''}>${l}</a></li>`,
      )
      .join('')}</ul></div>`;

  return `<footer class="footer"><div class="footin">
  <div>
    <a class="navbrand" style="color:var(--ink);margin-bottom:.8rem" href="${up || './'}">${MARK}<span>spec<i>d</i></span></a>
    <p class="footnote">Spec-driven delivery, productized.<br>MIT licensed · pre-1.0 · local-first.<br>© 2026 Junghwa Theodore Park</p>
  </div>
  ${col('Start', [
    ['What is specd?', `${up}docs/what-is-specd/`],
    ['Quickstart', `${up}docs/quickstart/`],
    ['Your first spec', `${up}docs/your-first-spec/`],
    ['Glossary', `${up}docs/glossary/`],
  ])}
  ${col('Reference', [
    ['CLI', `${up}docs/cli/`],
    ['MCP tools', `${up}docs/mcp/`],
    ['Configuration', `${up}docs/configuration/`],
    ['Architecture', `${up}docs/architecture/`],
  ])}
  ${col('Project', [
    ['GitHub', REPO],
    ['Contributing', `${REPO}/blob/main/CONTRIBUTING.md`],
    ['Security', `${REPO}/blob/main/SECURITY.md`],
    ['Licence', `${REPO}/blob/main/LICENSE`],
  ])}
</div></footer>`;
}

export function sidebar(up: Up, activeSlug?: string): string {
  const group = (c: DocCategory) =>
    `<div class="navgroup"><span>${esc(c.title)}</span><ul>${c.pages
      .map(
        (p) =>
          `<li><a href="${up}docs/${p.slug}/"${
            p.slug === activeSlug ? ' aria-current="page"' : ''
          }>${esc(p.title)}</a></li>`,
      )
      .join('')}</ul></div>`;

  return `<nav class="sidebar" aria-label="Documentation">
  <details class="railtoggle"><summary>All docs</summary></details>
  <div class="rails">${DOCS.map(group).join('')}</div>
</nav>`;
}

export function tocRail(page: DocPage, up: Up): string {
  const heads = outline(page);
  if (heads.length < 2) return '';
  return `<aside class="toc" aria-label="On this page"><span>On this page</span><ul>${heads
    .map((h) => `<li><a href="#${esc(h.id)}">${esc(h.text)}</a></li>`)
    .join('')}</ul><a class="tocedit" href="${REPO}/tree/main/apps/web/lib/docs">Improve this page →</a></aside>`;
}

export function tocInline(page: DocPage): string {
  const heads = outline(page);
  if (heads.length < 2) return '';
  return `<details class="tocinline"><summary>On this page</summary><ul>${heads
    .map((h) => `<li><a href="#${esc(h.id)}">${esc(h.text)}</a></li>`)
    .join('')}</ul></details>`;
}

/* ── the document ────────────────────────────────────────────────────────── */

export interface ShellOptions {
  title: string;
  description: string;
  up: Up;
  active: 'home' | 'docs';
  /** Site-root-relative path of this page, for the canonical link. */
  path: string;
  origin: string;
  body: string;
}

export function shell(o: ShellOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<link rel="canonical" href="${esc(o.origin)}/${o.path}">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${esc(o.origin)}/${o.path}">
<meta name="twitter:card" content="summary">
<link rel="icon" href="${o.up}favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${o.up}styles.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
${nav(o.up, o.active)}
${o.body}
${footer(o.up)}
</body>
</html>
`;
}
