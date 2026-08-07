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
  UnauthorizedException,
} from '@nestjs/common';
import { Config } from '../config.js';
import { Public } from '../auth/auth.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { TokenClaims } from '../auth/auth.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { GitLabAdapter } from './gitlab.adapter.js';
import { GitLabWebhookService } from './gitlab-webhook.service.js';
import { VcsService } from './vcs.service.js';
import { VcsError } from './vcs.types.js';
import { verifyToken } from './gitlab-webhook.verify.js';

/**
 * GitLab connection surface and webhook receiver (§11, §6 step 2).
 *
 * Smaller than `GitHubController` because GitLab has no App to register: a
 * connection is just a token (`POST /projects/:slug/connections/vcs`,
 * already provider-agnostic) plus, for self-managed instances, an instance
 * URL. What is left here is the one route GitLab calls, and the routes a
 * signed-in human calls to see what the token can reach.
 */
@Controller('gitlab')
export class GitLabController {
  private readonly logger = new Logger(GitLabController.name);

  constructor(
    private readonly config: Config,
    private readonly webhooks: GitLabWebhookService,
    private readonly vcs: VcsService,
    private readonly projects: ProjectsService,
  ) {}

  // ─── the route GitLab calls ────────────────────────────────────────────────

  /**
   * Webhook receiver. GitLab does not sign the body — the secret token in
   * `X-Gitlab-Token` is the entire trust boundary — so unlike GitHub's this
   * route needs no raw-body access and can take the parsed payload directly.
   *
   * Returns 2xx for anything successfully *received*, including events we
   * chose to ignore. A bad token is the exception: that is a 401.
   */
  @Public()
  @Post('webhook')
  @HttpCode(200)
  async webhook(
    @Body() payload: Record<string, unknown>,
    @Headers('x-gitlab-token') token: string | undefined,
    @Headers('x-gitlab-event') event: string | undefined,
    @Headers('x-gitlab-event-uuid') deliveryId: string | undefined,
  ) {
    const verified = verifyToken(token, this.config.gitlabWebhookSecret);

    if (!verified.ok) {
      // Distinguishable in our logs, opaque to the caller — same posture as
      // the GitHub receiver.
      this.logger.warn(
        `rejected webhook delivery ${deliveryId ?? '(no id)'} (${event ?? 'no event'}): ${verified.reason}`,
      );
      throw new UnauthorizedException('Invalid webhook token');
    }

    if (!event || !deliveryId) {
      throw new BadRequestException('Missing X-Gitlab-Event or X-Gitlab-Event-UUID');
    }

    const result = await this.webhooks.handle({ deliveryId, event, payload });
    this.logger.log(`${event}/${deliveryId} → ${result.outcome}: ${result.detail}`);
    return { ok: true, ...result };
  }

  // ─── the routes a human calls ──────────────────────────────────────────────

  /** Is a webhook secret configured at all? There is no App to register. */
  @Get('status')
  status() {
    const configured = Boolean(this.config.gitlabWebhookSecret);
    return {
      configured,
      reason: configured
        ? ''
        : 'GITLAB_WEBHOOK_SECRET is not set — every webhook delivery is rejected until it is.',
      docs: 'docs/gitlab.md',
    };
  }

  /**
   * The repo picker's source: what the connection's token can see (§11).
   *
   * This is the wizard's live validation for a pasted token — there is no
   * separate "test connection" call, so a bad token or an unreachable
   * self-managed instance has to surface here, in words someone can act on.
   * Nest's default filter reduces any non-`HttpException` to an opaque 500,
   * which would turn "your token is wrong" into "Internal server error" —
   * so `VcsError` is translated explicitly rather than left to fall through.
   */
  @Get('projects/:projectId/repositories')
  async repositories(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query('search') search: string | undefined,
    @CurrentUser() user: TokenClaims,
  ) {
    await this.projects.requireRole(user.sub, projectId, ['owner', 'maintainer', 'reviewer']);
    try {
      const { token, instanceUrl } = await this.vcs.gitlabCredential(projectId);
      const adapter = new GitLabAdapter(token, instanceUrl);
      return { repositories: await adapter.listRepositories(search) };
    } catch (err) {
      if (err instanceof VcsError) throw new BadRequestException(err.message);
      throw err;
    }
  }

  /** "Are the webhooks actually arriving?" — same question, GitLab's answer. */
  @Get('projects/:projectId/deliveries')
  async deliveries(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @CurrentUser() user: TokenClaims,
  ) {
    await this.projects.requireRole(user.sub, projectId, ['owner', 'maintainer', 'reviewer']);
    return { deliveries: await this.webhooks.recent(projectId) };
  }
}
