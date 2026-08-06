import { createPrivateKey, type KeyObject } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { SignJWT } from 'jose';
import { Config } from '../config.js';
import { VcsError } from './vcs.types.js';

interface CachedToken {
  token: string;
  expiresAt: number;
}

/**
 * GitHub App authentication (§11).
 *
 * The App itself authenticates with a short-lived RS256 JWT signed by its
 * private key. That JWT is only ever used to mint an *installation* token,
 * which is what actually touches a repository — scoped to the repos the
 * customer granted, and expiring in an hour.
 *
 * The private key never leaves this process and no installation token is
 * persisted: they are minted per run and cached in memory only. That is what
 * makes "short-lived scoped tokens per run" (§12) true rather than aspirational.
 */
@Injectable()
export class GitHubAppService {
  private readonly logger = new Logger(GitHubAppService.name);
  private readonly cache = new Map<string, CachedToken>();
  private privateKey: KeyObject | null = null;

  constructor(private readonly config: Config) {}

  get isConfigured(): boolean {
    return Boolean(this.config.githubAppId && this.config.githubPrivateKey);
  }

  /** Why the App cannot be used, phrased for the person who has to fix it. */
  get unconfiguredReason(): string {
    const missing: string[] = [];
    if (!this.config.githubAppId) missing.push('GITHUB_APP_ID');
    if (!this.config.githubPrivateKey) missing.push('GITHUB_APP_PRIVATE_KEY');
    if (!this.config.githubWebhookSecret) missing.push('GITHUB_WEBHOOK_SECRET (for webhooks)');
    return missing.length
      ? `GitHub App is not configured — missing ${missing.join(', ')}. See docs/github-app.md.`
      : '';
  }

  private key(): KeyObject {
    if (this.privateKey) return this.privateKey;

    const raw = this.config.githubPrivateKey;
    if (!raw) throw new VcsError(this.unconfiguredReason);

    let key: KeyObject;
    try {
      // GitHub issues PKCS#1 ("BEGIN RSA PRIVATE KEY"); createPrivateKey
      // accepts both that and PKCS#8, so either download works unmodified.
      key = createPrivateKey(raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw);
    } catch (err) {
      throw new VcsError(
        'GITHUB_APP_PRIVATE_KEY could not be read as a private key. Paste the .pem GitHub gave ' +
          'you, with real newlines or \\n escapes.',
        err,
      );
    }

    if (key.type !== 'private') {
      throw new VcsError(
        'GITHUB_APP_PRIVATE_KEY is not a private key. Use the .pem GitHub generated, not a ' +
          'public key or certificate.',
      );
    }

    this.privateKey = key;
    return key;
  }

  /** App-level JWT. Valid ten minutes; only ever exchanged for an installation token. */
  async appJwt(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(this.config.githubAppId)
      // Backdated by a minute: GitHub rejects a JWT whose iat is in the future,
      // and a second of clock skew is enough to trip that.
      .setIssuedAt(now - 60)
      .setExpirationTime(now + 540)
      .sign(this.key());
  }

  /**
   * An installation token for one customer installation. Cached until shortly
   * before expiry — minting one per API call would burn rate limit for nothing.
   */
  async installationToken(installationId: string): Promise<string> {
    const cached = this.cache.get(installationId);
    if (cached && cached.expiresAt > Date.now() + 120_000) return cached.token;

    const jwt = await this.appJwt();
    const res = await fetch(
      `${this.config.githubApiBase}/app/installations/${installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${jwt}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );

    if (!res.ok) {
      throw new VcsError(
        `GitHub refused an installation token for ${installationId} (${res.status}): ` +
          `${(await res.text()).slice(0, 300)}`,
      );
    }

    const body = (await res.json()) as { token: string; expires_at: string };
    const expiresAt = new Date(body.expires_at).getTime();
    this.cache.set(installationId, { token: body.token, expiresAt });
    this.logger.log(`minted installation token for ${installationId}, expires ${body.expires_at}`);
    return body.token;
  }

  /** Forget a cached token — used when an installation is revoked or suspended. */
  forget(installationId: string): void {
    this.cache.delete(installationId);
  }

  /**
   * The manifest GitHub uses to create the App in one click. Permissions are
   * the minimum the pipeline needs and no more:
   *
   *   contents:write      — push the setup and spec branches
   *   pull_requests:write — open the PRs those branches are reviewed in
   *   metadata:read       — mandatory for any App
   *
   * Notably absent: workflows, packages, org administration, and anything
   * granting access to code beyond the repositories the customer picks.
   */
  manifest(publicUrl: string, webhookUrl: string): Record<string, unknown> {
    return {
      name: 'specd',
      url: publicUrl,
      hook_attributes: { url: webhookUrl, active: true },
      redirect_url: `${publicUrl}/api/github/app/created`,
      public: false,
      default_permissions: {
        contents: 'write',
        pull_requests: 'write',
        metadata: 'read',
      },
      default_events: ['push', 'pull_request', 'installation', 'installation_repositories'],
    };
  }
}
