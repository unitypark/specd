/*
 * Preview the generated site.  `pnpm site:serve`, then http://localhost:8899.
 *
 * Deliberately not a dependency: the site is static files with relative links,
 * so all a preview has to do is map a directory URL onto its index.html — and
 * doing that in thirty lines keeps a dev-server package out of a repository
 * whose whole point is that Postgres is the only thing it needs.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('../../site/', import.meta.url).pathname;
const PORT = Number(process.env.PORT ?? 8899);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
};

createServer(async (req, res) => {
  // `normalize` collapses any `..` before the path is joined, so a request
  // cannot walk out of site/.
  const rel = normalize(decodeURI(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  let file = join(ROOT, rel);

  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
  } catch {
    /* fall through to the 404 below */
  }

  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(await readFile(join(ROOT, '404.html')).catch(() => 'not found'));
  }
}).listen(PORT, () => console.log(`site → http://localhost:${PORT}`));
