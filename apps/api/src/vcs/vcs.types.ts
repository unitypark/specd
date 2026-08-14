/**
 * The VCS boundary. Everything above this line — the onboarding agent, the
 * spec pipeline, the Learn step — is provider-agnostic; the adapters below it
 * differ only in how a change is proposed for review.
 *
 * The write path is the same everywhere and it is never a direct push:
 *   hosted providers → branch + pull request
 *   local mode       → branch, reviewed as a diff (no host account, no PRs)
 */

export interface RepoFile {
  path: string;
  content: string;
}

export interface RepoSnapshot {
  /** Every tracked path, for stack detection and layout summaries. */
  files: string[];
  /** Contents of the handful of manifests worth reading up front. */
  samples: RepoFile[];
  defaultBranch: string;
  headSha: string;
}

export interface ProposedChange {
  branch: string;
  title: string;
  body: string;
  files: RepoFile[];
}

export interface ChangeResult {
  branch: string;
  /** A PR/MR URL on hosted providers; null in local mode — there is no host. */
  url: string | null;
  /** What the human should do next, phrased for the UI. */
  reviewHint: string;
  filesWritten: number;
}

export interface RepoTarget {
  id: string;
  name: string;
  provider: string;
  localPath: string | null;
  externalId: string | null;
  defaultBranch: string;
}

export interface VcsAdapter {
  readonly provider: string;

  /** Read-only scan. The onboarding agent never gets write access to scan. */
  snapshot(repo: RepoTarget): Promise<RepoSnapshot>;

  /** Read a set of paths at HEAD (used to re-index knowledge/ after merge). */
  readFiles(repo: RepoTarget, paths: string[]): Promise<RepoFile[]>;

  /** List paths under a prefix at HEAD. */
  listFiles(repo: RepoTarget, prefix: string): Promise<string[]>;

  /**
   * The same listing with each file's content id — the git blob sha.
   *
   * Every provider already knows it: `git ls-files -s` prints it, and both
   * hosted tree APIs return it and used to throw it away. It is what lets an
   * index run tell "this file changed" from "this file is still here", which
   * is the difference between re-reading a repository and re-reading three
   * files.
   */
  listFilesWithSha(repo: RepoTarget, prefix: string): Promise<{ path: string; sha: string }[]>;

  /** Propose a change for human review. Never writes to the default branch. */
  propose(repo: RepoTarget, change: ProposedChange): Promise<ChangeResult>;
}

export class VcsError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'VcsError';
  }
}

/** What opening a review actually did, once a re-run is a normal thing to do. */
export interface OpenedReview {
  url: string;
  /** `#number` on GitHub, `!iid` on GitLab — the same thing to a reader. */
  number: number;
  /** One was already open for this branch and we updated it in place. */
  existing: boolean;
  /**
   * The description on the host no longer matches the branch. Only ever true
   * for an existing review whose rewrite failed: one we just opened carries
   * the description we opened it with.
   */
  descriptionStale: boolean;
}

/**
 * The one sentence a person gets when a run ends, in the four places that end
 * one. Kept together because the third case is easy to forget: a re-run whose
 * description could not be rewritten has updated the branch under a reviewer
 * without updating what the page tells them the branch contains, and silence
 * there reads as "this page is current".
 */
export function reviewHint(
  kind: 'PR' | 'MR',
  repoName: string,
  opened: Pick<OpenedReview, 'number' | 'existing' | 'descriptionStale'>,
): string {
  const ref = `${kind} ${kind === 'PR' ? '#' : '!'}${opened.number}`;
  const verb = opened.existing ? 'Updated' : 'Opened';
  const caveat = opened.descriptionStale
    ? ' Its description could not be rewritten and still describes the previous run.'
    : '';
  return `${verb} ${ref} on ${repoName}.${caveat} Merging is adopting.`;
}

/**
 * Root files worth reading in full during a scan — small, high-signal, cheap.
 * This is the first tier of the scan; `scan-targets.ts` adds the rest (CI,
 * workspace manifests, schemas, docs, entry points) under per-tier caps.
 */
export const MANIFEST_FILES = [
  'package.json',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'turbo.json',
  'nx.json',
  'deno.json',
  'pyproject.toml',
  'requirements.txt',
  'setup.py',
  'go.mod',
  'go.work',
  'Cargo.toml',
  'Gemfile',
  'mix.exs',
  'pubspec.yaml',
  'Package.swift',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'composer.json',
  'README.md',
  'readme.md',
  'README.rst',
  'CONTRIBUTING.md',
  'ARCHITECTURE.md',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'Dockerfile',
  'Makefile',
  'Taskfile.yml',
  'justfile',
  '.env.example',
  '.env.sample',
  '.env.template',
  // Agent instructions the repo already has. Onboarding must read these before
  // it proposes its own — overwriting a team's existing rules is not onboarding.
  'AGENTS.md',
  'CLAUDE.md',
  '.cursorrules',
];

/** Paths never worth scanning — noise that would drown the signal. */
export const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  'coverage',
  'vendor',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.terraform',
  '.gradle',
  '.idea',
  '.vscode',
]);
