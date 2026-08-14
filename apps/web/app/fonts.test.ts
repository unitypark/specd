import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const appDir = import.meta.dirname;
const fontsDir = join(appDir, 'fonts');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === 'fonts' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry) && !entry.endsWith('.test.ts') ? [path] : [];
  });
}

/**
 * The web app must not fetch its typefaces at build time.
 *
 * `next/font/google` downloads from fonts.gstatic.com while building, so a
 * production build depended on a third party being reachable — and twice it was
 * not, failing CI on changes that had nothing to do with the web app. A build
 * that can fail for a reason no commit caused is a build people learn to
 * re-run without reading it, which is how a real failure gets waved through.
 *
 * The import is easy to reach for again (it is what the Next docs show), so the
 * absence is asserted rather than remembered.
 */
describe('typefaces are vendored, not fetched', () => {
  it('imports no font from Google', () => {
    const offenders = sourceFiles(appDir).filter((path) =>
      readFileSync(path, 'utf8').includes("from 'next/font/google'"),
    );
    expect(offenders).toEqual([]);
  });

  it('ships every file the layout asks for', () => {
    const layout = readFileSync(join(appDir, 'layout.tsx'), 'utf8');
    const referenced = [...layout.matchAll(/path:\s*'\.\/fonts\/([^']+)'/g)].map((m) => m[1]!);

    // A layout referencing a file that is not here fails the build, but it
    // fails it in CI rather than here, and the message is about a module.
    expect(referenced.length).toBeGreaterThan(0);
    const present = new Set(readdirSync(fontsDir));
    for (const file of referenced) expect(present.has(file)).toBe(true);
  });

  it('keeps the licence beside every family it vendors', () => {
    // Both families are OFL-1.1, which permits bundling and requires the
    // licence to travel with the files. This repository is MIT; shipping a
    // font without its licence would make that claim wrong.
    const files = readdirSync(fontsDir);
    const woff2 = files.filter((f) => f.endsWith('.woff2'));
    expect(woff2.length).toBeGreaterThan(0);

    for (const family of new Set(woff2.map((f) => f.split('-')[0]!))) {
      expect(files.some((f) => f.startsWith('OFL-') && f.includes(family))).toBe(true);
    }
  });
});
