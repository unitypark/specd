import { Injectable } from '@nestjs/common';
import { ConnectionsService } from '../projects/connections.service.js';
import { Vault } from '../common/vault.js';
import { normalizeInstanceUrl, type LocalReviewCredential } from './vcs.types.js';

/**
 * The optional credential a local-mode project may hold for opening reviews.
 *
 * Local mode's promise is that specd does not hold a key to your host, and
 * that stands: without this, nothing changes. What it adds is a way to say
 * "open the merge request for me" for the case the `gh`/`glab` path cannot
 * serve — a self-managed instance, where specd deliberately refuses to guess
 * which software is running ([[0020-local-mode-borrows-the-host-cli]]) and the
 * host's CLI is often not installed on a corporate machine anyway.
 *
 * It lives on the project's existing `vcs` connection rather than a new row:
 * that connection is already `provider: 'local'` with an unused
 * `encrypted_secret` and an unused `settings.instanceUrl`, so this needed no
 * migration. `settings.reviewProvider` is the switch — absent means local mode
 * behaves exactly as it did.
 */
@Injectable()
export class LocalReviewService {
  constructor(
    private readonly connections: ConnectionsService,
    private readonly vault: Vault,
  ) {}

  /**
   * The review credential for a project, or null when there is none.
   *
   * Null is the ordinary answer and never an error: every local-mode project
   * that predates this has one, and the caller falls back to the CLI path and
   * then to a branch you diff.
   */
  async credentialFor(projectId: string | undefined): Promise<LocalReviewCredential | null> {
    if (!projectId) return null;

    const conn = await this.connections.get(projectId, 'vcs').catch(() => null);
    if (!conn || conn.provider !== 'local') return null;

    const settings = (conn.settings ?? {}) as { reviewProvider?: string; instanceUrl?: string | null };
    const provider = settings.reviewProvider;
    if (provider !== 'github' && provider !== 'gitlab') return null;

    // A credential that cannot be decrypted is not a reason to fail a run —
    // the branch is the work, and the review surface is best-effort by
    // construction everywhere else in this path. Nor is its absence: naming
    // the provider is enough for GitLab's push-option route.
    const token = conn.encryptedSecret
      ? (() => {
          try {
            return this.vault.decrypt(conn.encryptedSecret!, `${projectId}:vcs`);
          } catch {
            return null;
          }
        })()
      : null;

    return {
      provider,
      token: token || null,
      instanceUrl: settings.instanceUrl ? normalizeInstanceUrl(settings.instanceUrl) : null,
    };
  }
}
