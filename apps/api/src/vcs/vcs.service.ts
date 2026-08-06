import { BadRequestException, Injectable } from '@nestjs/common';
import type { Repository } from '@specd/db';
import { ConnectionsService } from '../projects/connections.service.js';
import { Vault } from '../common/vault.js';
import { GitHubAdapter } from './github.adapter.js';
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
  ) {}

  async adapterFor(repo: Repository): Promise<VcsAdapter> {
    switch (repo.provider) {
      case 'local':
        return this.local;

      case 'github': {
        const conn = await this.connections.get(repo.projectId, 'vcs');
        if (!conn?.encryptedSecret) {
          throw new BadRequestException(
            'GitHub is selected for this repository but no credential is stored. ' +
              'Reconnect GitHub in project settings.',
          );
        }
        const token = this.vault.decrypt(conn.encryptedSecret, `${repo.projectId}:vcs`);
        return new GitHubAdapter(token);
      }

      case 'gitlab':
        // P2. The interface is the contract; the adapter is the only thing missing.
        throw new BadRequestException(
          'GitLab support lands in P2. Use Local mode or GitHub for now.',
        );

      default:
        throw new BadRequestException(`Unknown VCS provider: ${repo.provider}`);
    }
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
