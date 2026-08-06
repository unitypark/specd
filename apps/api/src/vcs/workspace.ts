import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { simpleGit } from 'simple-git';
import type { Repository } from '@specd/db';
import { Config } from '../config.js';
import { GitHubAdapter } from './github.adapter.js';
import { VcsService } from './vcs.service.js';
import { VcsError } from './vcs.types.js';

export interface PublishResult {
  url: string | null;
  reviewHint: string;
}

export interface Workspace {
  /** Absolute path the build agent may edit. */
  dir: string;
  branch: string;
  baseBranch: string;
  /**
   * Make the branch reviewable where the team actually reviews.
   *
   * Local mode has nothing to do — the branch is already in the repository the
   * user pointed at. Hosted providers push it and open a PR, because a branch
   * in a temporary clone that is about to be deleted is not a deliverable.
   */
  publish: (pr: { title: string; body: string }) => Promise<PublishResult>;
  /** Removes the workspace. The branch it produced survives. */
  dispose: () => Promise<void>;
}

/**
 * Isolated build workspaces.
 *
 * A build agent edits real files, so it must never do that in the user's
 * working tree — an interrupted run would leave them with a dirty checkout on
 * an unexpected branch. Local repositories get a git worktree: its own
 * directory on its own branch, sharing the object store, free to throw away.
 * Hosted repositories get a shallow clone in a scratch directory, made with a
 * token that expires within the hour.
 */
@Injectable()
export class WorkspaceService {
  private readonly logger = new Logger(WorkspaceService.name);

  constructor(
    private readonly vcs: VcsService,
    private readonly config: Config,
  ) {}

  async create(repo: Repository, branch: string): Promise<Workspace> {
    switch (repo.provider) {
      case 'local':
        return this.createLocal(repo, branch);
      case 'github':
        return this.createGitHub(repo, branch);
      default:
        throw new VcsError(
          `Hosted builds do not support ${repo.provider} repositories yet. Use ` +
            '`specd spec pull` to hand the approved spec to your own agent.',
        );
    }
  }

  // ─── local: a worktree beside the repository ───────────────────────────────

  private async createLocal(repo: Repository, branch: string): Promise<Workspace> {
    if (!repo.localPath) throw new VcsError(`Repository "${repo.name}" has no local path`);

    const root = resolve(repo.localPath);
    const git = simpleGit({ baseDir: root });

    const status = await git.status();
    if (!status.isClean()) {
      throw new VcsError(
        `${repo.name} has uncommitted changes. Commit or stash them first — a build must start ` +
          'from a known state.',
      );
    }

    const baseBranch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
    const dir = join(root, '.specd-build', branch.replace(/[^a-z0-9._-]+/gi, '-'));

    // A worktree left behind by a crashed run would block this one.
    await this.forceRemove(root, dir);

    const branches = await git.branchLocal();
    if (branches.all.includes(branch)) {
      await git.raw(['worktree', 'add', '--force', dir, branch]);
    } else {
      await git.raw(['worktree', 'add', '-b', branch, dir, baseBranch]);
    }

    this.logger.log(`workspace ${dir} on ${branch} (from ${baseBranch})`);

    return {
      dir,
      branch,
      baseBranch,
      publish: async () => ({
        url: null,
        reviewHint:
          `Branch ${branch} is in ${root}. Review with \`git diff ${baseBranch}..${branch}\` ` +
          'and merge when you are happy — merging is adopting.',
      }),
      dispose: async () => {
        await this.forceRemove(root, dir);
      },
    };
  }

  // ─── github: a shallow clone with a short-lived token ──────────────────────

  private async createGitHub(repo: Repository, branch: string): Promise<Workspace> {
    if (!repo.name.includes('/')) {
      throw new VcsError(`GitHub repository name must be "owner/repo", got "${repo.name}"`);
    }

    const token = await this.vcs.githubToken(repo.projectId);
    const dir = await mkdtemp(join(this.config.buildRoot, 'specd-build-'));
    const cloneUrl = `${this.config.githubCloneBase}/${repo.name}.git`;

    try {
      // The token travels as a per-invocation header, never written into
      // .git/config. `git -c` before the subcommand configures *this* process
      // only; `git clone -c` would persist it into the new repository, leaving
      // a live credential on disk for as long as the workspace exists.
      await simpleGit().raw([
        ...this.authArgs(token),
        'clone',
        '--depth',
        '1',
        '--branch',
        repo.defaultBranch,
        '--no-tags',
        cloneUrl,
        dir,
      ]);
    } catch (err) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw new VcsError(
        `Could not clone ${repo.name}. Check the App is installed on it and that ` +
          `"${repo.defaultBranch}" is its default branch.`,
        err,
      );
    }

    const git = simpleGit({ baseDir: dir });
    const baseBranch = repo.defaultBranch;

    await git.addConfig('user.name', 'specd build');
    await git.addConfig('user.email', 'bot@specd.dev');
    await git.checkoutLocalBranch(branch);

    this.logger.log(`workspace ${dir} on ${branch} (clone of ${repo.name}@${baseBranch})`);

    return {
      dir,
      branch,
      baseBranch,
      publish: async (pr) => {
        // Push first, and treat it as the point of no return. Everything the
        // build produced lives only in this clone until now, and the clone is
        // deleted moments later — if the push fails there is nothing to salvage
        // and the run must say so.
        // Force-push: a re-run of the same spec replaces its branch rather than
        // failing on a non-fast-forward. The branch belongs to this spec.
        await git.raw([...this.authArgs(token), 'push', '--force', cloneUrl, `HEAD:${branch}`]);

        const adapter = new GitHubAdapter(token, this.config.githubApiBase);
        try {
          const opened = await adapter.openPullRequest(repo.name, {
            branch,
            base: baseBranch,
            title: pr.title,
            body: pr.body,
          });

          return {
            url: opened.url,
            reviewHint: opened.existing
              ? `Updated PR #${opened.number} on ${repo.name}. Merging is adopting.`
              : `Opened PR #${opened.number} on ${repo.name}. Merging is adopting.`,
          };
        } catch (err) {
          // The branch is safely pushed; only the review surface is missing.
          // Failing the whole build here would throw away work that survived,
          // over something the reviewer can do in one click.
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn(`pushed ${branch} but could not open a PR: ${message}`);
          return {
            url: `${this.config.githubBase}/${repo.name}/compare/${encodeURIComponent(
              baseBranch,
            )}...${encodeURIComponent(branch)}?expand=1`,
            reviewHint:
              `Pushed ${branch}, but opening the PR failed (${message.slice(0, 120)}). ` +
              'The work is safe on the branch — open the PR from the compare link.',
          };
        }
      },
      dispose: async () => {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  }

  /**
   * Authenticate a single git invocation without persisting the credential.
   * Same mechanism GitHub Actions uses, minus the part where it writes the
   * header into the repository's config and leaves it there.
   */
  private authArgs(token: string): string[] {
    const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
    return ['-c', `http.extraheader=AUTHORIZATION: basic ${basic}`];
  }

  private async forceRemove(root: string, dir: string): Promise<void> {
    const git = simpleGit({ baseDir: root });
    await git.raw(['worktree', 'remove', '--force', dir]).catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await git.raw(['worktree', 'prune']).catch(() => undefined);
  }

  /** Paths the agent changed, relative to the workspace. */
  async changedFiles(dir: string): Promise<string[]> {
    const git = simpleGit({ baseDir: dir });
    const status = await git.status();
    return [
      ...status.created,
      ...status.modified,
      ...status.not_added,
      ...status.renamed.map((r) => r.to),
    ].filter((p, i, all) => all.indexOf(p) === i);
  }

  async commitAll(dir: string, message: string): Promise<string | null> {
    const git = simpleGit({ baseDir: dir });
    await git.add('.');
    const status = await git.status();
    if (status.staged.length === 0) return null;

    await git.commit(message, undefined, { '--author': 'specd build <bot@specd.dev>' });
    return (await git.revparse(['HEAD'])).trim();
  }

  async commitCount(dir: string, baseBranch: string): Promise<number> {
    const git = simpleGit({ baseDir: dir });
    try {
      const out = await git.raw(['rev-list', '--count', `${baseBranch}..HEAD`]);
      return Number(out.trim()) || 0;
    } catch {
      return 0;
    }
  }
}

/** Default scratch root for hosted clones. */
export const DEFAULT_BUILD_ROOT = tmpdir();
