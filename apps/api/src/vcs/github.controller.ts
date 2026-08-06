import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Response } from 'express';
import { Config } from '../config.js';
import { Public, type RequestWithUser } from '../auth/auth.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { TokenClaims } from '../auth/auth.service.js';
import { ConnectionsService } from '../projects/connections.service.js';
import { GitHubAppService, isPubliclyReachable } from './github-app.service.js';
import { GitHubWebhookService } from './github-webhook.service.js';
import { GitHubAdapter } from './github.adapter.js';
import { VcsService } from './vcs.service.js';
import { verifySignature } from './github-webhook.verify.js';

interface RawBodyRequest extends RequestWithUser {
  rawBody?: Buffer;
}

/**
 * GitHub App install flow and webhook receiver (§11, §6 step 2).
 *
 * Two audiences share this controller and they are kept visibly apart: the
 * routes a signed-in human calls, and the one route GitHub calls. The latter
 * is `@Public()` because GitHub has no session — which is exactly why its
 * signature check is unconditional.
 */
@Controller('github')
export class GitHubController {
  private readonly logger = new Logger(GitHubController.name);

  constructor(
    private readonly config: Config,
    private readonly app: GitHubAppService,
    private readonly webhooks: GitHubWebhookService,
    private readonly connectionsService: ConnectionsService,
    private readonly vcs: VcsService,
  ) {}

  // ─── the route GitHub calls ────────────────────────────────────────────────

  /**
   * Webhook receiver.
   *
   * Returns 2xx for anything we successfully *received*, including events we
   * decide to ignore — GitHub disables an endpoint that keeps erroring, and a
   * spec we chose not to act on is not a delivery failure. A bad signature is
   * the exception: that gets a 401, loudly.
   */
  @Public()
  @Post('webhook')
  @HttpCode(200)
  async webhook(
    @Req() req: RawBodyRequest,
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Headers('x-github-event') event: string | undefined,
    @Headers('x-github-delivery') deliveryId: string | undefined,
  ) {
    const verified = verifySignature(req.rawBody, signature, this.config.githubWebhookSecret);

    if (!verified.ok) {
      // Distinguishable in our logs, opaque to the caller: a prober learns
      // only that it failed, never which check it failed.
      this.logger.warn(
        `rejected webhook delivery ${deliveryId ?? '(no id)'} (${event ?? 'no event'}): ` +
          verified.reason,
      );
      throw new UnauthorizedException('Invalid webhook signature');
    }

    if (!event || !deliveryId) {
      throw new BadRequestException('Missing X-GitHub-Event or X-GitHub-Delivery');
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(req.rawBody!.toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new BadRequestException('Webhook body was not JSON');
    }

    const result = await this.webhooks.handle({ deliveryId, event, payload });
    this.logger.log(`${event}/${deliveryId} → ${result.outcome}: ${result.detail}`);
    return { ok: true, ...result };
  }

  // ─── the routes a human calls ──────────────────────────────────────────────

  /** Is the App configured at all, and where does the install flow start? */
  @Get('status')
  status() {
    if (!this.config.githubAppConfigured) {
      return {
        configured: false,
        reason: this.app.unconfiguredReason,
        // Registering an App is a browser flow; the manifest makes it one form
        // submission instead of a dozen fields typed by hand.
        registerUrl: `${this.config.apiPublicUrl}/api/github/app/register`,
        docs: 'docs/github-app.md',
      };
    }

    return {
      configured: true,
      appSlug: this.config.githubAppSlug,
      installUrl: `${this.config.githubBase}/apps/${this.config.githubAppSlug}/installations/new`,
      webhookUrl: `${this.config.apiPublicUrl}/api/github/webhook`,
      webhookSecretSet: Boolean(this.config.githubWebhookSecret),
    };
  }

  /**
   * Serves a self-submitting form that hands GitHub the App manifest. GitHub
   * creates the App, then redirects back to `/app/created` with a temporary
   * code we exchange for the credentials.
   */
  @Public()
  @Get('app/register')
  register(@Query('org') org: string | undefined, @Res() res: Response) {
    const webhookUrl = `${this.config.apiPublicUrl}/api/github/webhook`;
    const manifest = this.app.manifest(this.config.apiPublicUrl, webhookUrl);
    const action = org
      ? `${this.config.githubBase}/organizations/${encodeURIComponent(org)}/settings/apps/new`
      : `${this.config.githubBase}/settings/apps/new`;

    // Say so rather than let someone discover it when merges are not detected.
    const noWebhook = !isPubliclyReachable(webhookUrl);
    const warning = noWebhook
      ? `<p style="background:#fff5e6;border-left:3px solid #e8a33d;padding:.75rem 1rem">
           <strong>Registering without a webhook.</strong> GitHub cannot deliver to
           <code>${escapeHtml(webhookUrl)}</code> — it is not reachable from the public internet, and
           GitHub rejects a manifest that says otherwise. The App will work for branches and PRs;
           merges will not be detected until you give it a public URL. Point
           <code>API_PUBLIC_URL</code> at a tunnel and re-register, or add the webhook URL later in
           the App's settings. See <code>docs/github-app.md</code>.
         </p>`
      : '';

    res.type('html').send(`<!doctype html>
<meta charset="utf-8">
<title>Register the specd GitHub App</title>
<body style="font-family:system-ui;margin:3rem auto;max-width:38rem;line-height:1.5">
  <h1>Registering the specd GitHub App…</h1>
  <p>GitHub will ask you to confirm. Permissions requested:
     <code>contents:write</code>, <code>pull_requests:write</code>, <code>metadata:read</code>.</p>
  ${warning}
  <form id="f" method="post" action="${action}">
    <input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
    <button type="submit">Continue to GitHub</button>
  </form>
  ${noWebhook ? '' : "<script>document.getElementById('f').submit()</script>"}
</body>`);
  }

  /**
   * GitHub's redirect after the manifest flow. The exchange is one-shot and the
   * code expires in an hour, so this prints the credentials for the operator to
   * put in the environment rather than storing them — a private key belongs in
   * the deployment's secret store, not in our database.
   */
  @Public()
  @Get('app/created')
  async created(@Query('code') code: string | undefined, @Res() res: Response) {
    if (!code) throw new BadRequestException('GitHub did not send a code');

    const response = await fetch(`${this.config.githubApiBase}/app-manifests/${code}/conversions`, {
      method: 'POST',
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });

    if (!response.ok) {
      throw new BadRequestException(
        `GitHub refused the manifest exchange (${response.status}). The code is single-use and ` +
          'expires after an hour — start again at /api/github/app/register.',
      );
    }

    const app = (await response.json()) as {
      id: number;
      slug: string;
      pem?: string;
      webhook_secret?: string | null;
      html_url: string;
    };

    // Registering without a webhook (a localhost deployment) means GitHub has
    // no secret to hand back. Printing `undefined` into someone's .env would
    // be worse than useless: an unset secret rejects every delivery, and they
    // would be hunting a value that was never real.
    const secretLine = app.webhook_secret
      ? `GITHUB_WEBHOOK_SECRET=${app.webhook_secret}`
      : '# GITHUB_WEBHOOK_SECRET=  ← no webhook was configured; see the note below';

    res.type('html').send(`<!doctype html>
<meta charset="utf-8">
<title>specd GitHub App created</title>
<body style="font-family:system-ui;margin:3rem auto;max-width:48rem;line-height:1.5">
  <h1>App created — one step left</h1>
  <p>Add these to the API's environment and restart it. They are shown once.</p>
  <pre style="background:#111;color:#eee;padding:1rem;border-radius:.5rem;overflow-x:auto">${escapeHtml(
    `GITHUB_APP_ID=${app.id}
GITHUB_APP_SLUG=${app.slug}
${secretLine}
GITHUB_APP_PRIVATE_KEY="${(app.pem ?? '').replace(/\n/g, '\\n')}"`,
  )}</pre>
  ${
    app.webhook_secret
      ? ''
      : `<p style="background:#fff5e6;border-left:3px solid #e8a33d;padding:.75rem 1rem">
           <strong>No webhook was configured</strong>, because GitHub could not reach this API.
           Branches and PRs work; merges will not be detected. When you have a public URL, add it
           under the App's <em>Settings → Webhook</em>, generate a secret there, and put that secret
           in <code>GITHUB_WEBHOOK_SECRET</code>.
         </p>`
  }
  <p>Then <a href="${escapeHtml(app.html_url)}/installations/new">install it on your repositories</a>.</p>
  <p style="color:#666">specd stores no part of this. The private key lives in your deployment's
     secret store; installation tokens are minted per run and never written down.</p>
</body>`);
  }

  /**
   * Record an installation against a project. This is what makes webhooks for
   * those repos resolvable, and what lets the repo picker read the granted list.
   */
  @Post('projects/:projectId/installation')
  async connect(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() body: { installationId?: string },
    @CurrentUser() user: TokenClaims,
  ) {
    this.logger.log(`${user.name} is connecting installation ${body.installationId}`);
    if (!body.installationId) {
      throw new BadRequestException('installationId is required');
    }
    if (!this.config.githubAppConfigured) {
      throw new BadRequestException(this.app.unconfiguredReason);
    }

    // Prove the installation exists and is ours before recording it, so a typo
    // fails here rather than as a silent no-op at the first webhook.
    const token = await this.app.installationToken(body.installationId);
    const adapter = new GitHubAdapter(token, this.config.githubApiBase);
    const repos = await adapter.listInstallationRepositories();

    await this.connectionsService.upsert({
      projectId,
      kind: 'vcs',
      provider: 'github',
      label: `GitHub App installation ${body.installationId}`,
      settings: { installationId: body.installationId },
      // No secret: the App's private key is the credential, and it is not
      // per-project. Nothing to encrypt, so nothing to leak (§12).
      secret: null,
    });

    return { installationId: body.installationId, repositories: repos };
  }

  /** The repo picker's source: exactly what the installation was granted. */
  @Get('projects/:projectId/repositories')
  async repositories(@Param('projectId', ParseUUIDPipe) projectId: string) {
    const adapter = await this.adapterFor(projectId);
    return { repositories: await adapter.listInstallationRepositories() };
  }

  /** "Are the webhooks actually arriving?" — the first question when they are not. */
  @Get('projects/:projectId/deliveries')
  async deliveries(@Param('projectId', ParseUUIDPipe) projectId: string) {
    return { deliveries: await this.webhooks.recent(projectId) };
  }

  private async adapterFor(projectId: string): Promise<GitHubAdapter> {
    // One place knows how to turn a project into a GitHub credential, and it
    // is not this controller.
    return new GitHubAdapter(await this.vcs.githubToken(projectId), this.config.githubApiBase);
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
