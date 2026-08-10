import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
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
import { KnowledgeService } from '../knowledge/knowledge.service.js';
import { RepositoriesService } from '../projects/repositories.service.js';
import { SpecsService } from '../specs/specs.service.js';
import {
  classifyMergeRequest,
  classifyPush,
  commitsFromPush,
  type MergeRequestEvent,
  type PushEvent,
  type WebhookIntent,
} from './gitlab-webhook.verify.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `project` sub-object as it appears on a Push Hook payload. */
type GitLabProjectRef = { path_with_namespace?: string; id?: number; default_branch?: string; web_url?: string };

/** A connection's stored instance URL, defaulting exactly as `VcsService.gitlabCredential` does. */
function instanceUrl(settings: unknown): string {
  const raw = (settings as { instanceUrl?: string | null } | null)?.instanceUrl;
  return raw || 'https://gitlab.com';
}

/** Lowercased host of a URL — the identity of "which GitLab" for comparison. Empty if unparseable. */
function hostOf(url: string | null | undefined): string {
  try {
    return new URL(url || 'https://gitlab.com').host.toLowerCase();
  } catch {
    return '';
  }
}

export interface DeliveryContext {
  deliveryId: string;
  event: string;
  payload: Record<string, unknown>;
}

export interface DeliveryOutcome {
  outcome: string;
  detail: string;
  projectId?: string;
}

/**
 * Turns GitLab events into pipeline state — the GitLab half of "merging is
 * adopting" (§6 step 6, station 06). Structurally this mirrors
 * `GitHubWebhookService` exactly (same table, same claim/dispatch/record
 * shape, same reindex-and-log philosophy); what differs is only what GitLab
 * actually sends: no installation lifecycle to track (there is no
 * installation), and a merge request instead of a pull request.
 */
@Injectable()
export class GitLabWebhookService {
  private readonly logger = new Logger(GitLabWebhookService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly repositories: RepositoriesService,
    private readonly specs: SpecsService,
    private readonly pipeline: PipelineService,
    private readonly knowledge: KnowledgeService,
  ) {}

  /**
   * Record the delivery, then handle it — in that order, and only if the
   * record was ours to write. A redelivery loses the insert race and returns
   * without doing the work twice.
   */
  async handle(ctx: DeliveryContext): Promise<DeliveryOutcome> {
    // X-Gitlab-Event-UUID is the deduplication key and the column is a uuid.
    // A malformed one would throw on insert and become a 500 GitLab would
    // retry forever — rejected here as the non-event it is, same as GitHub's.
    if (!UUID.test(ctx.deliveryId)) {
      this.logger.warn(`ignoring delivery with a non-uuid id: ${ctx.deliveryId.slice(0, 64)}`);
      return { outcome: 'ignored', detail: 'X-Gitlab-Event-UUID was not a uuid' };
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
      object_kind?: string;
      project?: { id?: number; path_with_namespace?: string };
    };

    const inserted = await this.db
      .insert(webhookDeliveries)
      .values({
        id: ctx.deliveryId,
        provider: 'gitlab',
        event: ctx.event,
        action: payload.object_kind ?? null,
        repoFullName: payload.project?.path_with_namespace ?? null,
        outcome: 'processing',
      })
      .onConflictDoNothing()
      .returning({ id: webhookDeliveries.id });

    return inserted.length > 0;
  }

  private async dispatch(ctx: DeliveryContext): Promise<DeliveryOutcome> {
    switch (ctx.event) {
      case 'Merge Request Hook':
        return this.onMergeRequest(ctx.payload as unknown as MergeRequestEvent);
      case 'Push Hook':
        return this.onPush(ctx.payload as unknown as PushEvent & { project?: GitLabProjectRef });
      default:
        return { outcome: 'ignored', detail: `no handler for ${ctx.event}` };
    }
  }

  // ─── event handlers ────────────────────────────────────────────────────────

  private async onMergeRequest(event: MergeRequestEvent): Promise<DeliveryOutcome> {
    const repo = await this.resolveRepo(event.project);
    if (!repo) return this.unmatched(event.project?.path_with_namespace);

    const intent = classifyMergeRequest(event, repo, (branch) => branch.startsWith('spec/'));

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

  /** The setup MR landed — the repo now carries `knowledge/`, so index it. */
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
    await this.reindex(repo, `setup MR !${intent.prNumber} merged`, intent.mergedBy);

    return {
      outcome: 'setup-merged',
      detail:
        `${repo.name}: setup MR !${intent.prNumber} merged` +
        `${intent.mergedBy ? ` by ${intent.mergedBy}` : ''} — indexing knowledge/`,
      projectId: repo.projectId,
    };
  }

  /** A spec branch landed — deliver the spec and re-index the as-built copy. */
  private async onSpecMerged(
    repo: Repository,
    intent: Extract<WebhookIntent, { kind: 'spec-merged' }>,
  ): Promise<DeliveryOutcome> {
    const spec = await this.specForBranch(repo.projectId, intent.branch);

    if (!spec) {
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
        `${repo.name}: MR !${intent.prNumber} (${intent.branch}) merged` +
        `${intent.mergedBy ? ` by ${intent.mergedBy}` : ''}${moved} — re-indexing`,
      projectId: repo.projectId,
    };
  }

  private async onPush(event: PushEvent & { project?: GitLabProjectRef }): Promise<DeliveryOutcome> {
    const repo = await this.resolveRepo(event.project);
    if (!repo) return this.unmatched(event.project?.path_with_namespace);

    const defaultBranch = event.project?.default_branch ?? repo.defaultBranch;
    const intent = classifyPush(event, defaultBranch);

    // Record the commits before deciding whether to re-index. A push that
    // touched only code triggers nothing here and is exactly what drift is
    // made of, so it has to reach the ledger anyway (0013).
    await this.knowledge.recordCommits(repo, commitsFromPush(event, defaultBranch));

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

  // ─── lookups ───────────────────────────────────────────────────────────────

  /**
   * Map a GitLab project to a registered repository. Prefers the numeric
   * project id — set when the repository was added through the picker — and
   * falls back to the namespaced path for repositories registered without it
   * (added by hand).
   *
   * The id and path are unique only *within one GitLab instance* — a second
   * self-managed instance (or gitlab.com) can easily have its own, unrelated
   * project #7. `web_url` says which instance actually sent this delivery, so
   * a candidate whose own connection points elsewhere is not an ambiguous
   * match, it is not a match at all: dropping it is what stops one instance's
   * merge from moving another instance's spec.
   */
  private async resolveRepo(project: GitLabProjectRef | undefined): Promise<Repository | null> {
    if (!project?.id || !project.path_with_namespace) return null;

    const externalId = String(project.id);
    const path = project.path_with_namespace;

    const rows = await this.db
      .select({ repo: repositories, instanceUrl: connections.settings })
      .from(repositories)
      .leftJoin(
        connections,
        and(
          eq(connections.projectId, repositories.projectId),
          eq(connections.kind, 'vcs'),
          eq(connections.provider, 'gitlab'),
        ),
      )
      .where(
        and(
          eq(repositories.provider, 'gitlab'),
          or(
            eq(repositories.externalId, externalId),
            and(isNull(repositories.externalId), eq(repositories.name, path)),
          ),
        ),
      );

    if (rows.length === 0) return null;

    // Undeterminable (no web_url on the payload) degrades to the old,
    // instance-blind behaviour rather than dropping the event outright — a
    // real ambiguity is rare and gets logged either way.
    const webhookHost = hostOf(project.web_url);
    const scoped = webhookHost ? rows.filter((r) => hostOf(instanceUrl(r.instanceUrl)) === webhookHost) : rows;

    if (scoped.length === 0) return null;
    if (scoped.length > 1) {
      this.logger.warn(
        `${path} (project ${externalId}) matches ${scoped.length} repositories on the same ` +
          'instance — using the first. Register the repository in only one specd project.',
      );
    }
    return scoped[0]!.repo;
  }

  /** Same reconstruction approach as the GitHub service — see there for why. */
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

  private async unmatched(path: string | undefined): Promise<DeliveryOutcome> {
    return {
      outcome: 'unmatched',
      detail:
        `${path ?? 'unknown project'} is not registered in any specd project with a ` +
        'matching GitLab project id — nothing to do',
    };
  }

  /** Station 06. Failures are logged on the delivery, never thrown at GitLab. */
  private async reindex(repo: Repository, why: string, actorUsername: string | null): Promise<void> {
    await this.pipeline.enqueueReindex({
      projectId: repo.projectId,
      repositoryIds: [repo.id],
      actor: null,
      triggeredByName: actorUsername ? `gitlab webhook (merged by ${actorUsername})` : 'gitlab webhook',
    });
    this.logger.log(
      `queued re-index of ${repo.name}: ${why}${actorUsername ? ` (merged by ${actorUsername})` : ''}`,
    );
  }

  /** Recent deliveries for a project — the "is the webhook actually arriving?" view. */
  async recent(projectId: string, limit = 20) {
    return this.db
      .select()
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.projectId, projectId), eq(webhookDeliveries.provider, 'gitlab')))
      .orderBy(desc(webhookDeliveries.receivedAt))
      .limit(limit);
  }
}
