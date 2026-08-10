/**
 * The one place link targets are normalized and resolved (S-102).
 *
 * Every producer — the extractor at index time, the re-resolution pass, any
 * future health check — resolves through these functions. An identity recipe
 * copy-pasted across producers drifts, and a drifted recipe is exactly the
 * `[[wiki-link]]`-stops-resolving class of bug; keeping it in one tested
 * module is the graphify `ids.py` lesson applied here.
 *
 * Resolution is exact-after-normalization only. No fuzzy matching, on
 * purpose: approximate target matching silently merges near-named docs, and
 * an unresolved link surfaced as a health signal is worth more than a wrong
 * edge that poisons retrieval.
 */

export interface ResolvableDoc {
  id: string;
  /** Repo-relative path, e.g. `knowledge/decisions/0004-runner-job-dispatch.md`. */
  path: string;
}

export interface ResolvedTarget {
  docId: string;
  path: string;
}

/**
 * Normalize free text into a comparable stem. Idempotent by construction —
 * `normalizeStem(normalizeStem(s)) === normalizeStem(s)` — and tested for it.
 */
export function normalizeStem(input: string): string {
  return input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\.md$/, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** `knowledge/decisions/0004-runner-job-dispatch.md` → `0004-runner-job-dispatch`. */
export function pathStem(path: string): string {
  const base = path.split('/').pop() ?? path;
  return normalizeStem(base);
}

/**
 * Resolve a `[[wiki-link]]` stem against the docs of a project.
 *
 * Two exact forms, tried in order, both after normalization:
 *   1. the full filename stem      — `[[0004-runner-job-dispatch]]`
 *   2. a prefix ending at a `-`    — `[[S-104]]` → `S-104-improve-cli-…`
 * The prefix form only wins when it is UNAMBIGUOUS: two docs both starting
 * `s-104-` means no resolution, not an arbitrary one.
 */
export function resolveWikiStem(raw: string, docs: ResolvableDoc[]): ResolvedTarget | null {
  const wanted = normalizeStem(raw);
  if (!wanted) return null;

  const exact = docs.filter((d) => pathStem(d.path) === wanted);
  if (exact.length === 1) return { docId: exact[0]!.id, path: exact[0]!.path };
  if (exact.length > 1) return null;

  const prefixed = docs.filter((d) => pathStem(d.path).startsWith(`${wanted}-`));
  if (prefixed.length === 1) return { docId: prefixed[0]!.id, path: prefixed[0]!.path };
  return null;
}

/**
 * Resolve a path-shaped target (citation, markdown link, backticked path)
 * against the docs of a project.
 *
 * Accepts the shapes that actually occur in this repo's knowledge tree:
 * absolute-from-repo (`knowledge/x.md`), relative with `./`/`../` segments
 * (resolved against the source doc's directory), and bare tree-relative
 * (`decisions/0008-….md`, resolved as knowledge/-rooted or source-relative).
 */
export function resolvePathTarget(
  raw: string,
  sourcePath: string,
  docs: ResolvableDoc[],
): ResolvedTarget | null {
  const target = raw.trim().replace(/^<|>$/g, '');
  if (!target || /^[a-z]+:\/\//i.test(target)) return null;

  const byPath = new Map(docs.map((d) => [d.path, d]));
  const candidates = new Set<string>();

  const cleaned = target.replace(/^\.\//, '');
  candidates.add(cleaned);
  candidates.add(`knowledge/${cleaned}`);

  // Relative to the source doc's own directory, with `..` segments applied.
  const sourceDir = sourcePath.split('/').slice(0, -1);
  const parts = [...sourceDir];
  for (const seg of target.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  candidates.add(parts.join('/'));

  for (const candidate of candidates) {
    const hit = byPath.get(candidate);
    if (hit) return { docId: hit.id, path: hit.path };
  }
  return null;
}

/** Anchor form used in citations and headings alike: "Auth flow" → "auth-flow". */
export function anchorOf(heading: string): string {
  return normalizeStem(heading);
}

/** Every heading anchor a doc's content defines, for dangling-anchor checks. */
export function headingAnchorsOf(content: string): Set<string> {
  const anchors = new Set<string>();
  let inFence = false;
  for (const line of content.split('\n')) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const m = /^#{1,6}\s+(.+)$/.exec(line);
    if (m?.[1]) anchors.add(anchorOf(m[1]));
  }
  return anchors;
}
