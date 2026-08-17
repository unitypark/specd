import { realpathSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Injectable } from '@nestjs/common';
import { simpleGit, type SimpleGit } from 'simple-git';
import { Config } from '../config.js';
import { parseCommitLog, type HistoryCommit } from '../knowledge/history.js';
import { detectHost, openLocalReview } from './local-review.js';
import { LocalReviewService } from './local-review.service.js';
import { collectSamples } from './scan-targets.js';
import {
  IGNORED_DIRS,
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

  constructor(
    private readonly config: Config,
    private readonly reviews: LocalReviewService,
  ) {}

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

    const samples = await collectSamples(visible, async ({ path }) => ({
      path,
      content: await readFile(this.safeJoin(root, path), 'utf8'),
    }));

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
    const raw = await git.raw(['ls-files', ...pathspec(prefix)]);
    return raw.split('\n').filter(Boolean);
  }

  async listFilesWithSha(
    repo: RepoTarget,
    prefix: string,
  ): Promise<{ path: string; sha: string }[]> {
    const { git } = this.git(repo);
    // `-s` prints "<mode> <sha> <stage>\t<path>".
    const raw = await git.raw(['ls-files', '-s', ...pathspec(prefix)]);
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [meta = '', path = ''] = line.split('\t');
        return { path, sha: meta.split(' ')[1] ?? '' };
      })
      .filter((f) => f.path);
  }

  /**
   * Writes the change to a branch, then opens a review for it where the repo
   * already lives.
   *
   * Local mode holds no credential for the host and never will — but the
   * machine it runs on is usually signed in to one already, and a branch
   * nobody has been asked to look at is not a deliverable. So when `origin`
   * points at a host whose CLI is installed and authenticated here, the branch
   * is pushed and a real PR/MR is opened with the person's own account
   * (`local-review.ts`, decision 0020). Where any of that is missing, the
   * behaviour is what it always was: a branch, and instructions to diff it.
   *
   * Nothing in the review path may fail this call. The commit is the work; the
   * review surface is how it reaches someone.
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

      // There may be no host at all — `origin` is optional in local mode, and
      // plenty of registered repos have never had one.
      const remoteUrl = await git
        .remote(['get-url', 'origin'])
        .then((r) => (r || '').trim())
        .catch(() => '');

      const review =
        this.config.localOpenPr && remoteUrl
          ? await openLocalReview({
              git,
              cwd: root,
              remoteUrl,
              branch: change.branch,
              base: startingBranch,
              title: change.title,
              body: change.body,
              credential: await this.reviews.credentialFor(repo.projectId),
            }).catch((err: unknown) => ({
              url: null,
              note: `opening a review failed (${err instanceof Error ? err.message : String(err)})`,
            }))
          : null;

      if (review?.url) {
        return {
          branch: change.branch,
          url: review.url,
          reviewHint:
            `Committed \`${change.branch}\` in ${root} and ${review.note}. ` +
            'Merging is adopting.',
          filesWritten: change.files.length,
        };
      }

      // No review surface. The compare URL is the one-command path to one, and
      // is worth spelling out: repos cloned from GitHub and connected in local
      // mode are the common case, and "review as a PR" should not require
      // knowing the compare-URL format by heart.
      const compare = remoteUrl
        ? hostedCompareUrl(remoteUrl, startingBranch, change.branch)
        : null;

      return {
        branch: change.branch,
        url: null,
        reviewHint:
          `Committed to branch \`${change.branch}\` in ${root}. Review it with ` +
          `\`git diff ${startingBranch}..${change.branch}\`, then merge when you are happy.` +
          // Says why there is no PR, rather than letting its absence read as a
          // deliberate choice the user made.
          (review ? ` No pull request was opened — ${review.note}.` : '') +
          (compare
            ? ` Open one yourself: \`git push -u origin ${change.branch}\` → ${compare}`
            : ''),
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
/**
 * Turn a prefix into git arguments.
 *
 * An empty prefix means "the whole tree", and git refuses to read it that
 * way: `git ls-files -- ''` is a hard error, `empty string is not a valid
 * pathspec`. So the pathspec is omitted entirely rather than passed empty.
 *
 * This was live for two releases and no test saw it, because every suite that
 * indexes uses a fake adapter that ignores the prefix. It surfaced the first
 * time a real local repository was indexed by a running server.
 */
function pathspec(prefix: string): string[] {
  return prefix ? ['--', prefix] : [];
}

async function sameDirectory(a: string, b: string): Promise<boolean> {
  if (a === b) return true;
  try {
    const [statA, statB] = await Promise.all([stat(a), stat(b)]);
    return statA.dev === statB.dev && statA.ino === statB.ino;
  } catch {
    return false;
  }
}

/**
 * A compare URL for a branch, when `origin` points at a host we can address.
 * Host detection is `detectHost`'s, so the link and the CLI that opens the
 * review can never disagree about which host this is. GitHub gets `?expand=1`
 * so the link lands on the open-PR form, not just the diff.
 */
export function hostedCompareUrl(remoteUrl: string, base: string, branch: string): string | null {
  const host = detectHost(remoteUrl);
  if (!host) return null;
  return host.kind === 'github'
    ? `https://github.com/${host.path}/compare/${base}...${branch}?expand=1`
    : `https://gitlab.com/${host.path}/-/compare/${base}...${branch}`;
}
