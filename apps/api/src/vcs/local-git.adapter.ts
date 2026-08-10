import { realpathSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Injectable } from '@nestjs/common';
import { simpleGit, type SimpleGit } from 'simple-git';
import { Config } from '../config.js';
import { parseCommitLog, type HistoryCommit } from '../knowledge/history.js';
import {
  IGNORED_DIRS,
  MANIFEST_FILES,
  VcsError,
  type ChangeResult,
  type ProposedChange,
  type RepoFile,
  type RepoSnapshot,
  type RepoTarget,
  type VcsAdapter,
} from './vcs.types.js';

/**
 * Local mode (§11). No host account, no webhooks, no PRs: the runner works on
 * the repo where it already lives, and setup lands as a branch you review as a
 * diff. Code never leaves the machine.
 *
 * Two invariants this adapter enforces, because local mode means the platform
 * is holding a real filesystem path:
 *   1. Every path stays inside the registered repo (no traversal).
 *   2. Every repo stays inside SPECD_LOCAL_REPO_ROOT when one is configured.
 */
@Injectable()
export class LocalGitAdapter implements VcsAdapter {
  readonly provider = 'local';

  constructor(private readonly config: Config) {}

  private git(repo: RepoTarget): { git: SimpleGit; root: string } {
    const root = this.repoRoot(repo);
    return { git: simpleGit({ baseDir: root, maxConcurrentProcesses: 2 }), root };
  }

  private repoRoot(repo: RepoTarget): string {
    if (!repo.localPath) {
      throw new VcsError(`Repository "${repo.name}" has no local path registered`);
    }
    const root = resolve(repo.localPath);
    if (!isAbsolute(root)) {
      throw new VcsError(`Local repo path must be absolute: ${repo.localPath}`);
    }
    const allowedRoot = this.config.localRepoRoot;
    if (allowedRoot) {
      // Canonicalize both sides before comparing, so a symlinked or
      // differently-cased path is not wrongly refused. Anything that still
      // falls outside the root is refused — this check fails closed.
      const base = realpathOr(resolve(allowedRoot));
      const canonical = realpathOr(root);
      if (canonical !== base && !canonical.startsWith(base + sep)) {
        throw new VcsError(
          `Repository path is outside SPECD_LOCAL_REPO_ROOT (${base}) and was refused`,
        );
      }
    }
    return root;
  }

  /** Resolves a repo-relative path, refusing anything that escapes the root. */
  private safeJoin(root: string, path: string): string {
    const target = resolve(root, path);
    const rel = relative(root, target);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new VcsError(`Refusing to touch a path outside the repository: ${path}`);
    }
    return target;
  }

  async snapshot(repo: RepoTarget): Promise<RepoSnapshot> {
    const { git, root } = this.git(repo);

    let files: string[];
    let headSha = '';
    let defaultBranch = repo.defaultBranch;

    try {
      // `git ls-files` respects .gitignore for free and never sees untracked junk.
      const raw = await git.raw(['ls-files']);
      files = raw.split('\n').filter(Boolean);
      headSha = (await git.revparse(['HEAD'])).trim();
      const branch = await git.revparse(['--abbrev-ref', 'HEAD']);
      defaultBranch = branch.trim() || defaultBranch;
    } catch (err) {
      throw new VcsError(
        `Could not read ${root} as a git repository. Run \`git init\` there first.`,
        err,
      );
    }

    const visible = files.filter((f) => !f.split('/').some((seg) => IGNORED_DIRS.has(seg)));

    const wanted = new Set(MANIFEST_FILES);
    const samples: RepoFile[] = [];
    for (const path of visible) {
      if (!wanted.has(path)) continue;
      try {
        const content = await readFile(this.safeJoin(root, path), 'utf8');
        samples.push({ path, content: content.slice(0, 40_000) });
      } catch {
        // A manifest we cannot read is simply one we do not report on.
      }
    }

    return { files: visible, samples, defaultBranch, headSha };
  }

  async readFiles(repo: RepoTarget, paths: string[]): Promise<RepoFile[]> {
    const root = this.repoRoot(repo);
    const out: RepoFile[] = [];
    for (const path of paths) {
      try {
        const content = await readFile(this.safeJoin(root, path), 'utf8');
        out.push({ path, content });
      } catch {
        // Missing file — the caller's list is a request, not a guarantee.
      }
    }
    return out;
  }

  async listFiles(repo: RepoTarget, prefix: string): Promise<string[]> {
    const { git } = this.git(repo);
    const raw = await git.raw(['ls-files', '--', prefix]);
    return raw.split('\n').filter(Boolean);
  }

  /**
   * Writes the change to a branch and leaves it there. No push, no PR, no
   * merge — a human reviews the diff and merges it themselves. Local mode is
   * the trust path; it does not get to be clever.
   */
  async propose(repo: RepoTarget, change: ProposedChange): Promise<ChangeResult> {
    const { git, root } = this.git(repo);

    const status = await git.status();
    if (!status.isClean()) {
      throw new VcsError(
        `${repo.name} has uncommitted changes. Commit or stash them first — specd will not ` +
          'write over work in progress.',
      );
    }

    const startingBranch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();

    try {
      const branches = await git.branchLocal();
      if (branches.all.includes(change.branch)) {
        await git.checkout(change.branch);
      } else {
        await git.checkoutLocalBranch(change.branch);
      }

      for (const file of change.files) {
        const target = this.safeJoin(root, file.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.content, 'utf8');
      }

      await git.add(change.files.map((f) => f.path));
      await git.commit(`${change.title}\n\n${change.body}`, undefined, {
        '--author': 'specd <bot@specd.dev>',
      });

      return {
        branch: change.branch,
        url: null,
        reviewHint:
          `Committed to branch \`${change.branch}\` in ${root}. Review it with ` +
          `\`git diff ${startingBranch}..${change.branch}\`, then merge when you are happy.`,
        filesWritten: change.files.length,
      };
    } finally {
      // Always hand the working tree back the way we found it.
      await git.checkout(startingBranch).catch(() => undefined);
    }
  }

  /** Last commit time for a path — feeds knowledge freshness (§P6). */
  async lastCommitDate(repo: RepoTarget, path: string): Promise<Date | null> {
    const { git } = this.git(repo);
    try {
      const out = await git.raw(['log', '-1', '--format=%cI', '--', path]);
      const trimmed = out.trim();
      return trimmed ? new Date(trimmed) : null;
    } catch {
      return null;
    }
  }

  /**
   * Commits in a window with the files each touched (0013). One `git log`
   * walk; both the parsing and the coupling rules live in knowledge/history.ts
   * so they stay testable without a fixture repository.
   */
  async commitFiles(repo: RepoTarget, since: Date): Promise<HistoryCommit[]> {
    const { git } = this.git(repo);
    try {
      const out = await git.raw([
        'log',
        `--since=${since.toISOString()}`,
        '--name-only',
        '--no-merges',
        '--no-renames',
        // NUL starts each record; the header is one line, so the parser never
        // has to tell a field separator from a record separator.
        '--pretty=format:%x00%H %cI',
      ]);
      return parseCommitLog(out);
    } catch {
      return [];
    }
  }

  /**
   * True only when `path` is itself the root of a repository.
   *
   * `checkIsRepo()` alone is not enough: it walks *up* the tree, so any
   * directory nested inside a repo reports true. Registering such a path would
   * make specd commit into the enclosing repository instead — so we compare
   * against the resolved top level and require an exact match.
   */
  async isGitRepo(path: string): Promise<boolean> {
    return (await this.repoRootOf(path)) !== null;
  }

  private async repoRootOf(path: string): Promise<string | null> {
    try {
      const target = resolve(path);
      const git = simpleGit({ baseDir: target });
      const topLevel = resolve((await git.revparse(['--show-toplevel'])).trim());

      // Compare identity, not spelling. git returns the canonical path, which
      // can differ from what the user typed by symlink (/tmp → /private/tmp)
      // or by case on a case-insensitive filesystem — both still name the
      // same directory, and a string compare would wrongly reject them.
      return (await sameDirectory(target, topLevel)) ? target : null;
    } catch {
      return null;
    }
  }

  async describe(path: string): Promise<{ clean: boolean; branch: string; head: string } | null> {
    const root = await this.repoRootOf(path);
    if (!root) return null;
    try {
      const git = simpleGit({ baseDir: root });
      const status = await git.status();
      const branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
      const head = (await git.revparse(['HEAD'])).trim();
      return { clean: status.isClean(), branch, head };
    } catch {
      return null;
    }
  }

  static joinRepoPath(root: string, path: string): string {
    return join(root, path);
  }
}

/** realpath, or the input when the path does not exist yet. */
function realpathOr(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/** Two paths name the same directory when they share a device and inode. */
async function sameDirectory(a: string, b: string): Promise<boolean> {
  if (a === b) return true;
  try {
    const [statA, statB] = await Promise.all([stat(a), stat(b)]);
    return statA.dev === statB.dev && statA.ino === statB.ino;
  } catch {
    return false;
  }
}
