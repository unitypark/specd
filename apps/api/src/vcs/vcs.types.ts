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

/** Manifests worth reading during a scan — small, high-signal, cheap. */
export const MANIFEST_FILES = [
  'package.json',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'pyproject.toml',
  'requirements.txt',
  'go.mod',
  'Cargo.toml',
  'Gemfile',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'README.md',
  'readme.md',
  'CONTRIBUTING.md',
  'docker-compose.yml',
  'Makefile',
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
