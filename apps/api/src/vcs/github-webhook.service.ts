import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  connections,
  repositories,
  specs,
  tickets,
  webhookDeliveries,
  type Db,
  type Repository,
} from '@specd/db';
import { slugify, specBranchName } from '@specd/shared';
import { DB } from '../db/db.module.js';
import { PipelineService } from '../agents/pipeline.service.js';
import { RepositoriesService } from '../projects/repositories.service.js';
import { SpecsService } from '../specs/specs.service.js';
import { GitHubAppService } from './github-app.service.js';
import {
  classifyPullRequest,
  classifyPush,
  type PullRequestEvent,
  type PushEvent,
  type WebhookIntent,
} from './github-webhook.verify.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DeliveryContext {
  deliveryId: string;
  event: string;
  payload: Record<string, unknown>;
}

export interface DeliveryOutcome {
  outcome: string;
  detail: string;
  /** Set once the event is attributed, so the delivery log is filterable by project. */
  projectId?: string;
}

/**
 * Turns GitHub events into pipeline state (§6 step 6, station 06).
 *
 * The point of this class is that **merging is adopting**. Before it existed,
 * someone had to come back to specd and press "I merged it" — a button that
 * recorded a claim rather than a fact, and that people forget to press. Now
 * the merge itself is the signal, and the index follows the repository instead
 * of following someone's memory (D4).
 *
 * Everything here is best-effort in one specific sense: an event we cannot
 * attribute to a project is *recorded and dropped*, never guessed at.
 */
@Injectable()
export class GitHubWebhookService {
  private readonly logger = new Logger(GitHubWebhookService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly repositories: RepositoriesService,
    private readonly specs: SpecsService,
    private readonly pipeline: PipelineService,
    private readonly app: GitHubAppService,
  ) {}

  /**
   * Record the delivery, then handle it — in that order, and only if the
   * record was ours to write. A redelivery loses the insert race and returns
   * without doing the work twice.
   */
  async handle(ctx: DeliveryContext): Promise<DeliveryOutcome> {
    // The delivery id is the deduplication key and the column is a uuid. A
    // malformed one would throw on insert, become a 500, and have GitHub retry
    // it forever — so it is rejected here as the non-event it is.
    if (!UUID.test(ctx.deliveryId)) {
      this.logger.warn(`ignoring delivery with a non-uuid id: ${ctx.deliveryId.slice(0, 64)}`);
      return { outcome: 'ignored', detail: 'X-GitHub-Delivery was not a uuid' };
    }

    const claimed = await this.claim(ctx);
    if (!claimed) {
      return { outcome: 'duplicate', detail: `delivery ${ctx.deliveryId} was already handled` };
    }

    let result: DeliveryOutcome;
    try {
      result = await this.dispatch(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`webhook ${ctx.event}/${ctx.deliveryId} failed: ${message}`);
      result = { outcome: 'error', detail: message };
    }

    await this.db
      .update(webhookDeliveries)
      .set({
        outcome: result.outcome,
        detail: result.detail.slice(0, 2000),
        projectId: result.projectId ?? null,
      })
      .where(eq(webhookDeliveries.id, ctx.deliveryId));

    return result;
  }

  /** Insert-or-lose. Returns false when this delivery was already seen. */
  private async claim(ctx: DeliveryContext): Promise<boolean> {
    const payload = ctx.payload as {
      action?: string;
      installation?: { id?: number };
      repository?: { full_name?: string };
    };

    const inserted = await this.db
      .insert(webhookDeliveries)
      .values({
        id: ctx.deliveryId,
        provider: 'github',
        event: ctx.event,
        action: payload.action ?? null,
        installationId: payload.installation?.id ? String(payload.installation.id) : null,
        repoFullName: payload.repository?.full_name ?? null,
        outcome: 'processing',
      })
      .onConflictDoNothing()
      .returning({ id: webhookDeliveries.id });

    return inserted.length > 0;
  }

  private async dispatch(ctx: DeliveryContext): Promise<DeliveryOutcome> {
    switch (ctx.event) {
      case 'ping':
        return { outcome: 'ignored', detail: 'ping — the App is wired up correctly' };
      case 'pull_request':
        return this.onPullRequest(ctx.payload as unknown as PullRequestEvent);
      case 'push':
        return this.onPush(ctx.payload as unknown as PushEvent);
      case 'installation':
      case 'installation_repositories':
        return this.onInstallation(ctx.payload as Record<string, unknown>);
      default:
        return { outcome: 'ignored', detail: `no handler for ${ctx.event}` };
    }
  }

  // ─── event handlers ────────────────────────────────────────────────────────

  private async onPullRequest(event: PullRequestEvent): Promise<DeliveryOutcome> {
    const repo = await this.resolveRepo(
      event.repository?.full_name,
      event.installation?.id,
    );
    if (!repo) return this.unmatched(event.repository?.full_name);

    const intent = classifyPullRequest(event, repo, (branch) => branch.startsWith('spec/'));

    switch (intent.kind) {
      case 'ignore':
        return { outcome: 'ignored', detail: intent.why, projectId: repo.projectId };

      case 'setup-merged':
        return this.onSetupMerged(repo, intent);

      case 'spec-merged':
        return this.onSpecMerged(repo, intent);

      default:
        return { outcome: 'ignored', detail: 'no action' };
    }
  }

  /**
   * The setup PR landed — the repo now carries `knowledge/`, so grounding can
   * stop being a proposal and become an index.
   */
  private async onSetupMerged(
    repo: Repository,
    intent: Extract<WebhookIntent, { kind: 'setup-merged' }>,
  ): Promise<DeliveryOutcome> {
    if (repo.setupState === 'merged') {
      return {
        outcome: 'ignored',
        detail: 'setup was already recorded as merged',
        projectId: repo.projectId,
      };
    }

    await this.repositories.markSetupMerged(repo.projectId, repo.id);
    await this.reindex(repo, `setup PR #${intent.prNumber} merged`, intent.mergedBy);

    return {
      outcome: 'setup-merged',
      detail:
        `${repo.name}: setup PR #${intent.prNumber} merged` +
        `${intent.mergedBy ? ` by ${intent.mergedBy}` : ''} — indexing knowledge/`,
      projectId: repo.projectId,
    };
  }

  /**
   * A spec branch landed. Two things become true at once: the work is
   * delivered, and the as-built spec that rode the same branch is now part of
   * the repository — so it is now part of the index (D4, station 06).
   */
  private async onSpecMerged(
    repo: Repository,
    intent: Extract<WebhookIntent, { kind: 'spec-merged' }>,
  ): Promise<DeliveryOutcome> {
    const spec = await this.specForBranch(repo.projectId, intent.branch);

    if (!spec) {
      // Someone else's `spec/…` branch, or a spec deleted since the build.
      // Re-index anyway: whatever merged is in the repo now.
      await this.reindex(repo, `merged ${intent.branch}`, intent.mergedBy);
      return {
        outcome: 'reindex',
        detail: `${intent.branch} merged but matched no spec — re-indexed ${repo.name} anyway`,
        projectId: repo.projectId,
      };
    }

    let moved = '';
    if (spec.status === 'building' || spec.status === 'approved') {
      // No actor: a merge is not an approval, and `transition` refuses to let
      // an unattributed caller reach a human-only status. Delivered is not one.
      await this.specs.transition({
        projectId: repo.projectId,
        specId: spec.id,
        to: 'delivered',
        actor: null,
      });
      moved = ` · ${spec.ticketKey} → delivered`;
    }

    await this.reindex(repo, `${spec.ticketKey} merged`, intent.mergedBy);

    return {
      outcome: 'spec-merged',
      detail:
        `${repo.name}: PR #${intent.prNumber} (${intent.branch}) merged` +
        `${intent.mergedBy ? ` by ${intent.mergedBy}` : ''}${moved} — re-indexing`,
      projectId: repo.projectId,
    };
  }

  private async onPush(event: PushEvent): Promise<DeliveryOutcome> {
    const repo = await this.resolveRepo(event.repository?.full_name, event.installation?.id);
    if (!repo) return this.unmatched(event.repository?.full_name);

    const defaultBranch = event.repository?.default_branch ?? repo.defaultBranch;
    const intent = classifyPush(event, defaultBranch);

    if (intent.kind !== 'reindex') {
      return {
        outcome: 'ignored',
        detail: intent.kind === 'ignore' ? intent.why : 'no action',
        projectId: repo.projectId,
      };
    }

    await this.reindex(repo, intent.why, null);
    return { outcome: 'reindex', detail: `${repo.name}: ${intent.why}`, projectId: repo.projectId };
  }

  /**
   * Installation lifecycle. A revoked installation must stop being usable
   * immediately — the cached token is dropped and the connection is marked, so
   * the next run fails with "reconnect GitHub" instead of a raw 401.
   */
  private async onInstallation(payload: Record<string, unknown>): Promise<DeliveryOutcome> {
    const action = String(payload.action ?? '');
    const installation = payload.installation as { id?: number; account?: { login?: string } };
    const id = installation?.id ? String(installation.id) : null;
    if (!id) return { outcome: 'ignored', detail: 'installation event without an id' };

    if (action === 'deleted' || action === 'suspend') {
      this.app.forget(id);
      const updated = await this.db
        .update(connections)
        .set({ status: action === 'deleted' ? 'revoked' : 'suspended' })
        .where(
          and(
            eq(connections.kind, 'vcs'),
            eq(connections.provider, 'github'),
            sql`${connections.settings} ->> 'installationId' = ${id}`,
          ),
        )
        .returning({ id: connections.id });

      return {
        outcome: 'installation-revoked',
        detail: `installation ${id} ${action} — ${updated.length} connection(s) marked`,
      };
    }

    if (action === 'unsuspend') {
      await this.db
        .update(connections)
        .set({ status: 'connected' })
        .where(
          and(
            eq(connections.kind, 'vcs'),
            eq(connections.provider, 'github'),
            sql`${connections.settings} ->> 'installationId' = ${id}`,
          ),
        );
      return { outcome: 'installation-restored', detail: `installation ${id} unsuspended` };
    }

    // created / added / removed: the repo picker reads live from the
    // installation, so there is no local list to keep in step.
    return { outcome: 'ignored', detail: `installation.${action} needs no local change` };
  }

  // ─── lookups ───────────────────────────────────────────────────────────────

  /**
   * Map `owner/repo` + installation id to a registered repository.
   *
   * The installation id is part of the match, not decoration: two projects can
   * legitimately register the same repository name, and the installation is
   * what says which one this event belongs to.
   */
  private async resolveRepo(
    fullName: string | undefined,
    installationId: number | undefined,
  ): Promise<Repository | null> {
    if (!fullName) return null;

    const rows = await this.db
      .select({ repo: repositories })
      .from(repositories)
      .innerJoin(connections, eq(connections.projectId, repositories.projectId))
      .where(
        and(
          eq(repositories.provider, 'github'),
          eq(repositories.name, fullName),
          eq(connections.kind, 'vcs'),
          eq(connections.provider, 'github'),
          installationId
            ? sql`${connections.settings} ->> 'installationId' = ${String(installationId)}`
            : sql`true`,
        ),
      )
      .limit(2);

    if (rows.length === 0) return null;
    if (rows.length > 1) {
      this.logger.warn(
        `${fullName} (installation ${installationId}) matches ${rows.length} projects — ` +
          'using the first. Register the repo in one project, or use separate installations.',
      );
    }
    return rows[0]!.repo;
  }

  /**
   * Find the spec a branch belongs to by *reconstructing* branch names rather
   * than parsing them. `spec/crm-14-2-factor-auth` cannot be split back into
   * key and slug unambiguously, so we never try — we compute what each
   * candidate spec's branch would be and look for an exact match.
   */
  private async specForBranch(projectId: string, branch: string) {
    const rows = await this.db
      .select({
        id: specs.id,
        status: specs.status,
        version: specs.version,
        ticketKey: tickets.key,
        title: tickets.title,
      })
      .from(specs)
      .innerJoin(tickets, eq(tickets.id, specs.ticketId))
      .where(
        and(
          eq(specs.projectId, projectId),
          inArray(specs.status, ['approved', 'building', 'delivered']),
        ),
      )
      .orderBy(desc(specs.version));

    return rows.find((row) => specBranchName(row.ticketKey, slugify(row.title)) === branch) ?? null;
  }

  private async unmatched(fullName: string | undefined): Promise<DeliveryOutcome> {
    return {
      outcome: 'unmatched',
      detail:
        `${fullName ?? 'unknown repository'} is not registered in any specd project with a ` +
        'matching installation — nothing to do',
    };
  }

  /** Station 06. Failures are logged on the delivery, never thrown at GitHub. */
  private async reindex(repo: Repository, why: string, actorLogin: string | null): Promise<void> {
    await this.pipeline.reindex({
      projectId: repo.projectId,
      repositoryIds: [repo.id],
      // A merge has no specd user behind it — attributing it to one would be a
      // lie in the audit trail. The GitHub login goes in the name instead.
      actor: null,
      triggeredByName: actorLogin ? `github webhook (merged by ${actorLogin})` : 'github webhook',
    });
    this.logger.log(
      `re-indexed ${repo.name}: ${why}${actorLogin ? ` (merged by ${actorLogin})` : ''}`,
    );
  }

  /** Recent deliveries for a project — the "is the webhook actually arriving?" view. */
  async recent(projectId: string, limit = 20) {
    return this.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.projectId, projectId))
      .orderBy(desc(webhookDeliveries.receivedAt))
      .limit(limit);
  }

  /** Deliveries not yet attributed to a project — the debugging view. */
  async recentAll(limit = 20) {
    return this.db
      .select()
      .from(webhookDeliveries)
      .orderBy(desc(webhookDeliveries.receivedAt))
      .limit(limit);
  }
}
