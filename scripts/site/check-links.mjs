/*
 * Walks every generated page and resolves every local link and asset against
 * the files on disk.  `pnpm site:check`.
 *
 * The docs corpus already has a test asserting that authored `/docs/…` links
 * point at real pages (apps/web/lib/docs/docs.test.ts). This checks the other
 * half — that the *renderer* turned them into paths that exist at the depth
 * they were emitted at. Relative links are what make the site work under
 * /specd/ and under a custom domain without a base-path setting, and an
 * off-by-one `../` is invisible in review and obvious to a visitor.
 *
 * Off-site links are listed, not fetched: a link checker that makes network
 * calls fails for reasons no commit caused, which is how a check gets ignored.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, normalize, relative, resolve } from 'node:path';

const ROOT = new URL('../../site/', import.meta.url).pathname.replace(/\/$/, '');

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else yield p;
  }
}

const exists = (p) =>
  stat(p).then(
    (s) => (s.isDirectory() ? stat(join(p, 'index.html')).then(() => true, () => false) : true),
    () => false,
  );

const HREF = /(?:href|src)="([^"]+)"/g;

let checked = 0;
let external = 0;
const broken = [];
const anchors = [];

for await (const file of walk(ROOT)) {
  if (!file.endsWith('.html')) continue;
  const html = await readFile(file, 'utf8');
  const here = dirname(file);

  /*
   * 404.html is the one page whose links are absolute — it is served for any
   * missing path at any depth, so a relative link would resolve against the
   * URL that failed. Its links carry the deploy base ("/specd/", or "/" under
   * a custom domain), which is not a directory on disk. Rather than hardcode
   * the base, read it off the page's own stylesheet link: the generator emits
   * both from the same value, so this stays correct if the base changes.
   */
  const base = html.match(/href="(\/[^"]*?)styles\.css"/)?.[1] ?? null;

  for (const [, raw] of html.matchAll(HREF)) {
    if (/^[a-z]+:/i.test(raw) || raw.startsWith('//')) {
      external++;
      continue;
    }
    if (raw.startsWith('#')) {
      // In-page anchor: the target id must be somewhere in this document.
      if (!html.includes(`id="${raw.slice(1)}"`)) anchors.push(`${relative(ROOT, file)} → ${raw}`);
      continue;
    }
    checked++;
    let target;
    if (raw.startsWith('/')) {
      if (!base || !raw.startsWith(base)) {
        broken.push(`${relative(ROOT, file)} → ${raw} (absolute, outside the deploy base)`);
        continue;
      }
      target = join(ROOT, raw.slice(base.length));
    } else {
      target = resolve(here, raw.split('#')[0]);
    }
    if (!(await exists(normalize(target)))) broken.push(`${relative(ROOT, file)} → ${raw}`);
  }
}

console.log(`checked ${checked} local links (+${external} off-site, not fetched)`);
if (anchors.length) {
  console.error(`\n${anchors.length} dangling in-page anchor(s):`);
  for (const a of anchors) console.error(`  ${a}`);
}
if (broken.length) {
  console.error(`\n${broken.length} broken link(s):`);
  for (const b of broken) console.error(`  ${b}`);
}
if (broken.length || anchors.length) process.exit(1);
console.log('no broken links');
