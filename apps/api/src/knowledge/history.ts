/**
 * Doc↔code coupling from commit history (0013).
 *
 * Pure: it takes commits already read out of git and returns coupling. The
 * git call lives in the adapter, so every rule below — the window, the bulk
 * cut-off, the path filters — is testable on a handful of literal commits
 * rather than on a fixture repository.
 */

export interface HistoryCommit {
  sha: string;
  at: Date;
  /** Repo-relative paths touched, in any order. */
  files: string[];
}

export interface CouplingEdge {
  docPath: string;
  codePath: string;
  commitsTogether: number;
  lastTogetherAt: Date;
  /** Commits touching this code path after the doc last moved with it. */
  commitsSince: number;
}

/**
 * Parse `git log --name-only` output written with a NUL record separator.
 *
 * Pure and exported because the parsing is the part that is easy to get
 * subtly wrong: NUL separates the record *and* the fields, so splitting the
 * whole output on it yields sha and date as siblings rather than as a pair.
 * One header line per record avoids that entirely.
 */
export function parseCommitLog(out: string): HistoryCommit[] {
  const NUL = String.fromCharCode(0);
  const commits: HistoryCommit[] = [];

  for (const record of out.split(NUL)) {
    if (!record.trim()) continue;
    const [header = '', ...rest] = record.split('\n');
    const [sha, iso] = header.trim().split(' ');
    if (!sha || !iso) continue;
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) continue;
    commits.push({ sha, at, files: rest.map((f) => f.trim()).filter(Boolean) });
  }
  return commits;
}

/**
 * A commit larger than this is a formatting sweep, a dependency bump or a mass
 * rename. It couples everything to everything, and precision never recovers
 * from being told that the README changes with all 400 source files.
 */
export const MAX_FILES_PER_COMMIT = 50;

/** Paths that co-change with everything for reasons nobody wants surfaced. */
const IGNORED = [
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|go\.sum|Cargo\.lock|poetry\.lock)$/,
  /(^|\/)(node_modules|dist|build|out|coverage|vendor|\.next|__snapshots__)\//,
  /\.(lock|min\.js|map|snap)$/,
];

const isKnowledgeDoc = (path: string) => path.startsWith('knowledge/') && path.endsWith('.md');
const isIgnored = (path: string) => IGNORED.some((re) => re.test(path));

/**
 * Group a code path to something a human can read. A doc coupled to nine files
 * in one directory has one relationship, not nine, and listing all of them
 * buries the signal it is supposed to give.
 */
export function codeArea(path: string): string {
  const parts = path.split('/');
  if (parts.length <= 1) return path;
  // Keep enough of the path to be meaningful, not so much that two siblings
  // look like separate concerns.
  return `${parts.slice(0, Math.min(3, parts.length - 1)).join('/')}/`;
}

/**
 * Coupling for every doc that moved with code inside the window.
 *
 * `commitsSince` counts, per coupled area, the commits that touched it *after*
 * the last commit in which the doc moved with it. That is the drift number:
 * the ground moving under a doc that stayed still. Passing the doc's own last
 * change date is not enough, because a doc can be edited without being
 * reconciled with the code — what matters is the last time they moved
 * together.
 */
export function couplingFrom(commits: HistoryCommit[]): CouplingEdge[] {
  const usable = commits
    .filter((c) => c.files.length <= MAX_FILES_PER_COMMIT)
    .map((c) => ({ ...c, files: c.files.filter((f) => !isIgnored(f)) }))
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  /** doc → area → { n, last } */
  const together = new Map<string, Map<string, { n: number; last: Date }>>();
  /** area → every commit time that touched it, ascending. */
  const areaTouches = new Map<string, Date[]>();

  for (const commit of usable) {
    const docs = commit.files.filter(isKnowledgeDoc);
    const areas = [...new Set(commit.files.filter((f) => !isKnowledgeDoc(f)).map(codeArea))];

    for (const area of areas) {
      areaTouches.set(area, [...(areaTouches.get(area) ?? []), commit.at]);
    }
    if (docs.length === 0 || areas.length === 0) continue;

    for (const doc of docs) {
      const byArea = together.get(doc) ?? new Map<string, { n: number; last: Date }>();
      for (const area of areas) {
        const current = byArea.get(area);
        byArea.set(area, { n: (current?.n ?? 0) + 1, last: commit.at });
      }
      together.set(doc, byArea);
    }
  }

  const edges: CouplingEdge[] = [];
  for (const [docPath, byArea] of together) {
    for (const [codePath, { n, last }] of byArea) {
      const touches = areaTouches.get(codePath) ?? [];
      edges.push({
        docPath,
        codePath,
        commitsTogether: n,
        lastTogetherAt: last,
        commitsSince: touches.filter((at) => at.getTime() > last.getTime()).length,
      });
    }
  }

  // Strongest coupling first, then most-drifted, so a truncating consumer
  // keeps the rows worth reading.
  return edges.sort(
    (a, b) => b.commitsTogether - a.commitsTogether || b.commitsSince - a.commitsSince,
  );
}
