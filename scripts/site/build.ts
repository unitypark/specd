/*
 * Builds the published site into `site/`.
 *
 *   pnpm site:build          # → site/, open site/index.html
 *   SITE_ORIGIN=… pnpm site:build
 *
 * The pages come from `apps/web/lib/docs` — the same modules the app renders
 * at /docs — so the published documentation cannot drift from the in-app
 * documentation. There is no bundler and no framework here on purpose: the
 * output is static HTML plus one stylesheet, which is the whole of what
 * GitHub Pages needs and the fastest thing to serve.
 *
 * Output is gitignored. `.github/workflows/pages.yml` runs this and uploads
 * `site/` as the Pages artifact, so nothing generated is ever committed.
 */

import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUDIENCE_LABEL,
  DOCS,
  PAGES,
  categoryOf,
  neighbours,
  type DocPage,
} from '../../apps/web/lib/docs/index';
import {
  esc,
  plain,
  renderBlocks,
  renderInline,
  shell,
  sidebar,
  tocInline,
  tocRail,
} from './render';
import { landing } from './landing';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = join(ROOT, 'site');

/*
 * Where the site is published. Only used for canonical/OG URLs and the
 * sitemap — every in-page link is relative, so getting this wrong costs SEO
 * metadata and nothing else.
 *
 * `||` rather than `??`: CI passes this from `actions/configure-pages`, which
 * yields an empty string when Pages is not enabled on the repository yet, and
 * `new URL('')` throws an error naming nothing that would help.
 */
const ORIGIN = (process.env.SITE_ORIGIN || 'https://unitypark.github.io/specd').replace(/\/$/, '');

/**
 * The path the site is mounted at — `/specd/` on a GitHub project site, `/`
 * under a custom domain. Only 404.html needs it: every other page links
 * relatively, which is what keeps the two cases from needing separate builds.
 */
const BASE = `${new URL(ORIGIN).pathname.replace(/\/$/, '')}/`;

async function page(path: string, html: string) {
  const file = path === '' ? join(OUT, 'index.html') : join(OUT, path, 'index.html');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, html);
}

/* ── docs index ──────────────────────────────────────────────────────────── */

function docsIndex(): string {
  const up = '../';
  const body = `
<div class="docsgrid nototc">
  ${sidebar(up)}
  <article class="article wide" id="main">
    <p class="crumb">DOCS</p>
    <h1>Documentation</h1>
    <p class="summary">
      specd puts one document between a request and the code: a spec that a named person read and
      approved, with a citation behind every design claim. These pages cover what that means, how to
      run it, and every command and setting it takes.
    </p>
    <ul class="meta">
      <li>${PAGES.length} pages</li>
      <li>Pre-1.0 · local-first</li>
      <li>MIT</li>
    </ul>

    <div class="body">
      <h2 id="new-here">New here? Three steps.</h2>
      <div class="cards">
        <a class="c" href="${up}docs/quickstart/"><h4>01 · Run it</h4><p>Clone, install, and one command brings up Postgres, the API and the web app.</p></a>
        <a class="c" href="${up}docs/ground-your-repository/"><h4>02 · Ground a repository</h4><p>specd reads your repo and opens a pull request carrying your first knowledge base.</p></a>
        <a class="c" href="${up}docs/your-first-spec/"><h4>03 · Approve a spec</h4><p>A ticket becomes a cited spec. You stamp it, and only then does an agent build.</p></a>
      </div>

      <h2 id="everything">Everything, by category</h2>
      <p>
        Read straight down the left rail if you are new — the order is the order a newcomer should
        meet these ideas. Every page has a reading time and says who it is written for.
      </p>
      ${DOCS.map(
        (c) => `
      <h3 id="${esc(c.title.toLowerCase().replace(/\s+/g, '-'))}">${esc(c.title)}</h3>
      <p class="catblurb">${esc(c.blurb)}</p>
      <ul class="catlist">${c.pages
        .map(
          (p) => `<li><a href="${up}docs/${p.slug}/">
          <span class="n">${esc(p.title)}</span>
          <span class="s">${renderInline(p.summary, up)}</span>
          <span class="m">${AUDIENCE_LABEL[p.audience]} · ${p.minutes} min</span>
        </a></li>`,
        )
        .join('')}</ul>`,
      ).join('')}
    </div>
  </article>
</div>`;

  return shell({
    title: 'Documentation · specd',
    description:
      'How specd turns a ticket into a cited, human-approved spec — and only then lets an agent write code. Start here, core concepts, guides, and the full reference.',
    up,
    active: 'docs',
    path: 'docs/',
    origin: ORIGIN,
    body,
  });
}

/* ── one doc page ────────────────────────────────────────────────────────── */

function docPage(p: DocPage): string {
  const up = '../../';
  const category = categoryOf(p.slug);
  const { prev, next } = neighbours(p.slug);
  const rail = tocRail(p, up);

  const body = `
<div class="docsgrid${rail ? '' : ' nototc'}">
  ${sidebar(up, p.slug)}
  <article class="article" id="main">
    <p class="crumb"><a href="${up}docs/">DOCS</a>${
      category ? ` · ${esc(category.title.toUpperCase())}` : ''
    }</p>
    <h1>${esc(p.title)}</h1>
    <p class="summary">${renderInline(p.summary, up)}</p>
    <ul class="meta">
      <li>${AUDIENCE_LABEL[p.audience]}</li>
      <li>${p.minutes} min read</li>
    </ul>
    ${tocInline(p)}
    <div class="body">
${renderBlocks(p.blocks, up)}
    </div>
    <nav class="pager" aria-label="More documentation">
      ${
        prev
          ? `<a class="prev" href="${up}docs/${prev.slug}/"><span>PREVIOUS</span><strong>${esc(prev.title)}</strong></a>`
          : '<span></span>'
      }
      ${
        next
          ? `<a class="next" href="${up}docs/${next.slug}/"><span>NEXT</span><strong>${esc(next.title)}</strong></a>`
          : ''
      }
    </nav>
  </article>
  ${rail}
</div>`;

  return shell({
    title: `${p.title} · specd docs`,
    description: plain(p.summary),
    up,
    active: 'docs',
    path: `docs/${p.slug}/`,
    origin: ORIGIN,
    body,
  });
}

/* ── the rest of the tree ────────────────────────────────────────────────── */

function notFound(): string {
  const body = `
<main id="main"><div class="section closing">
  <span class="kicker">404</span>
  <h2 class="h2">That page is not here.</h2>
  <p class="lede">It may have been renamed. The documentation index lists every page.</p>
  <div class="ctas" style="justify-content:center">
    <a class="btn primary" href="${BASE}docs/">All documentation</a>
    <a class="btn ghost" href="${BASE}">Home</a>
  </div>
</div></main>`;

  // 404.html is served for any missing path at any depth, so its links cannot
  // be relative — the browser would resolve them against the URL that failed.
  return shell({
    title: 'Not found · specd',
    description: 'That page is not here.',
    up: BASE,
    active: 'docs',
    path: '404.html',
    origin: ORIGIN,
    body,
  });
}

function sitemap(): string {
  const urls = ['', 'docs/', ...PAGES.map((p) => `docs/${p.slug}/`)];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${ORIGIN}/${u}</loc></url>`).join('\n')}
</urlset>
`;
}

/* ── build ───────────────────────────────────────────────────────────────── */

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  await page('', landing(ORIGIN));
  await page('docs', docsIndex());
  for (const p of PAGES) await page(`docs/${p.slug}`, docPage(p));

  await writeFile(join(OUT, '404.html'), notFound());
  await writeFile(join(OUT, 'sitemap.xml'), sitemap());
  await writeFile(
    join(OUT, 'robots.txt'),
    `User-agent: *\nAllow: /\nSitemap: ${ORIGIN}/sitemap.xml\n`,
  );
  // Without this, GitHub Pages runs the output through Jekyll, which ignores
  // any directory starting with an underscore and can rewrite what it serves.
  await writeFile(join(OUT, '.nojekyll'), '');

  await cp(join(HERE, 'site.css'), join(OUT, 'styles.css'));
  await cp(join(ROOT, 'apps/web/app/icon.svg'), join(OUT, 'favicon.svg'));

  // The repo's own self-hosted fonts, licences included — the site must not
  // fetch type from a third party at render time any more than the app does.
  await mkdir(join(OUT, 'fonts'), { recursive: true });
  for (const f of [
    'JosefinSans-Variable.woff2',
    'JosefinSans-Italic-Variable.woff2',
    'JetBrainsMono-Variable.woff2',
    'OFL-JosefinSans.txt',
    'OFL-JetBrainsMono.txt',
  ]) {
    await cp(join(ROOT, 'apps/web/app/fonts', f), join(OUT, 'fonts', f));
  }

  await cp(join(ROOT, 'apps/web/public/shots'), join(OUT, 'shots'), { recursive: true });

  console.log(`site → ${OUT}`);
  console.log(`  1 landing · 1 docs index · ${PAGES.length} doc pages · 404 · sitemap`);
  console.log(`  origin: ${ORIGIN}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
