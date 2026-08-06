import { BadRequestException, Injectable } from '@nestjs/common';
import type { Repository } from '@specd/db';
import { ConnectionsService } from '../projects/connections.service.js';
import { Vault } from '../common/vault.js';
import { Config } from '../config.js';
import { GitHubAdapter } from './github.adapter.js';
import { GitHubAppService } from './github-app.service.js';
import { LocalGitAdapter } from './local-git.adapter.js';
import type { RepoTarget, VcsAdapter } from './vcs.types.js';

/**
 * Picks the adapter for a repository. This is the only place that knows which
 * providers exist — every caller above it works against `VcsAdapter`.
 */
@Injectable()
export class VcsService {
  constructor(
    private readonly local: LocalGitAdapter,
    private readonly connections: ConnectionsService,
    private readonly vault: Vault,
    private readonly app: GitHubAppService,
    private readonly config: Config,
  ) {}

  async adapterFor(repo: Repository): Promise<VcsAdapter> {
    switch (repo.provider) {
      case 'local':
        return this.local;

      case 'github':
        return new GitHubAdapter(await this.githubToken(repo.projectId), this.config.githubApiBase);

      case 'gitlab':
        // P2. The interface is the contract; the adapter is the only thing missing.
        throw new BadRequestException(
          'GitLab support lands in P2. Use Local mode or GitHub for now.',
        );

      default:
        throw new BadRequestException(`Unknown VCS provider: ${repo.provider}`);
    }
  }

  /**
   * A GitHub token for this project, minted fresh where possible.
   *
   * Two shapes, in order of preference:
   *
   *   installation — the App mints a token scoped to the granted repos that
   *                  expires in an hour. Nothing is stored, so nothing leaks.
   *   stored PAT   — the pre-App path, still supported for anyone using it.
   *                  Long-lived and broadly scoped, which is exactly why the
   *                  App exists.
   */
  async githubToken(projectId: string): Promise<string> {
    const conn = await this.connections.get(projectId, 'vcs');
    if (!conn) {
      throw new BadRequestException(
        'This project has no GitHub connection. Install the specd GitHub App in project settings.',
      );
    }

    if (conn.status === 'revoked' || conn.status === 'suspended') {
      throw new BadRequestException(
        `The GitHub App installation for this project is ${conn.status}. Reinstall it to continue.`,
      );
    }

    const installationId = (conn.settings as { installationId?: string }).installationId;
    if (installationId) return this.app.installationToken(installationId);

    if (conn.encryptedSecret) {
      return this.vault.decrypt(conn.encryptedSecret, `${projectId}:vcs`);
    }

    throw new BadRequestException(
      'The GitHub connection has neither an App installation nor a stored token. Reconnect it.',
    );
  }

  toTarget(repo: Repository): RepoTarget {
    return {
      id: repo.id,
      name: repo.name,
      provider: repo.provider,
      localPath: repo.localPath,
      externalId: repo.externalId,
      defaultBranch: repo.defaultBranch,
    };
  }

  get localAdapter(): LocalGitAdapter {
    return this.local;
  }
}
