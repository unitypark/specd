import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { simpleGit } from 'simple-git';
import type { Repository } from '@specd/db';
import { VcsError } from './vcs.types.js';

export interface Workspace {
  /** Absolute path the build agent may edit. */
  dir: string;
  branch: string;
  baseBranch: string;
  /** Removes the workspace. The branch it produced survives. */
  dispose: () => Promise<void>;
}

/**
 * Isolated build workspaces.
 *
 * A build agent edits real files, so it must never do that in the user's
 * working tree — an interrupted run would leave them with a dirty checkout on
 * an unexpected branch. A git worktree gives the agent its own directory on
 * its own branch, sharing the object store, and throwing it away afterwards
 * costs nothing.
 */
@Injectable()
export class WorkspaceService {
  private readonly logger = new Logger(WorkspaceService.name);

  async create(repo: Repository, branch: string): Promise<Workspace> {
    if (repo.provider !== 'local') {
      // The build station needs a checkout it can edit. For hosted providers
      // that means cloning with a scoped token, which arrives with the GitHub
      // App integration — say so rather than half-doing it.
      throw new VcsError(
        `Hosted builds currently run on local repositories only. "${repo.name}" is a ` +
          `${repo.provider} repository; use \`specd spec pull\` to hand the spec to your own agent.`,
      );
    }
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
      dispose: async () => {
        await this.forceRemove(root, dir);
      },
    };
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
