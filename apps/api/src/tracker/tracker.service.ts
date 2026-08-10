import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { projects, tickets, type Db } from '@specd/db';
import type { SpecStatus } from '@specd/shared';
import { ConnectionsService } from '../projects/connections.service.js';
import { Vault } from '../common/vault.js';
import { Config } from '../config.js';
import { DB } from '../db/db.module.js';
import { JiraAdapter, JiraError } from './jira.adapter.js';

/**
 * The tracker side of a project: the built-in board, or Jira.
 *
 * Two rules shape everything here, both from
 * `knowledge/decisions/0010-jira-via-api-token-and-a-mirror-that-cannot-fail.md`:
 *
 *  1. **The mirror can never fail a specd action.** The spec lifecycle and the
 *     human gate are specd's own state and specd's own guarantee (§12). An
 *     Atlassian outage must not stop a team approving their own work, and a
 *     timeout must never leave the two systems disagreeing about whether an
 *     approval happened. So every outbound call is best-effort and returns a
 *     description of what happened instead of throwing.
 *  2. **Status mapping is explicit and empty by default.** No guessing at what
 *     a team's "Done" is called.
 */

export interface TrackerSettings {
  projectKey?: string | null;
  siteUrl?: string | null;
  email?: string | null;
  /** specd lifecycle state → Jira status *name*. Empty means no mirroring. */
  statusMap?: Partial<Record<SpecStatus, string>> | null;
}

/** What a best-effort mirror call did, for the run log. */
export interface MirrorOutcome {
  ok: boolean;
  detail: string;
}

@Injectable()
export class TrackerService {
  private readonly logger = new Logger(TrackerService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly connections: ConnectionsService,
    private readonly vault: Vault,
    private readonly config: Config,
  ) {}

  /** The Jira adapter for a project, or null when it does not use Jira. */
  async jiraFor(projectId: string): Promise<JiraAdapter | null> {
    const conn = await this.connections.get(projectId, 'tracker');
    if (!conn || conn.provider !== 'jira' || !conn.encryptedSecret) return null;

    const settings = (conn.settings ?? {}) as TrackerSettings;
    if (!settings.siteUrl || !settings.email) return null;

    const token = this.vault.decrypt(conn.encryptedSecret, `${projectId}:tracker`);
    return new JiraAdapter(settings.siteUrl, settings.email, token);
  }

  /** Same, but for the paths where Jira is required and its absence is a user error. */
  async requireJira(projectId: string): Promise<{ jira: JiraAdapter; settings: TrackerSettings }> {
    const conn = await this.connections.get(projectId, 'tracker');
    if (!conn || conn.provider !== 'jira') {
      throw new BadRequestException(
        'This project is not connected to Jira. Connect it in project settings.',
      );
    }
    const jira = await this.jiraFor(projectId);
    if (!jira) {
      throw new BadRequestException('The Jira connection is incomplete. Reconnect it.');
    }
    return { jira, settings: (conn.settings ?? {}) as TrackerSettings };
  }

  async settings(projectId: string): Promise<TrackerSettings | null> {
    const conn = await this.connections.get(projectId, 'tracker');
    if (!conn || conn.provider !== 'jira') return null;
    return (conn.settings ?? {}) as TrackerSettings;
  }

  /**
   * Post the backlink that makes specd findable from Jira.
   *
   * A person living in Jira should be able to see that a spec exists and open
   * it, without anyone telling them specd is where it went.
   */
  async commentSpecLink(input: {
    projectId: string;
    issueKey: string;
    text: string;
  }): Promise<MirrorOutcome> {
    return this.bestEffort('comment', input.issueKey, async () => {
      const jira = await this.jiraFor(input.projectId);
      if (!jira) return { ok: false, detail: 'no Jira connection — skipped' };

      await jira.addComment(input.issueKey, input.text);
      return { ok: true, detail: `commented on ${input.issueKey}` };
    });
  }

  /**
   * Move the Jira issue to whatever this project maps the new spec status to.
   *
   * Three normal non-events, none of them errors: no Jira connection, no
   * mapping for this status, or no such transition available from where the
   * issue currently sits (Jira workflows have guards).
   */
  async mirrorStatus(input: {
    projectId: string;
    issueKey: string;
    to: SpecStatus;
  }): Promise<MirrorOutcome> {
    return this.bestEffort('transition', input.issueKey, async () => {
      const conn = await this.connections.get(input.projectId, 'tracker');
      if (!conn || conn.provider !== 'jira') return { ok: false, detail: 'no Jira connection — skipped' };

      const settings = (conn.settings ?? {}) as TrackerSettings;
      const target = settings.statusMap?.[input.to];
      if (!target) {
        return { ok: false, detail: `no Jira status mapped for "${input.to}" — skipped` };
      }

      const jira = await this.jiraFor(input.projectId);
      if (!jira) return { ok: false, detail: 'the Jira connection is incomplete — skipped' };

      const moved = await jira.transitionTo(input.issueKey, target);
      return moved
        ? { ok: true, detail: `${input.issueKey} → "${target}"` }
        : {
            ok: false,
            detail: `Jira offers no transition to "${target}" from ${input.issueKey}'s current status — left alone`,
          };
    });
  }

  /**
   * React to a spec changing state: comment the backlink, mirror the status.
   *
   * The single hook for every transition, however it was triggered — a human
   * approving, the build station moving to `building`, a merge webhook
   * flipping to `delivered`. Returns quietly for tickets that did not come
   * from Jira, which is most of them.
   *
   * Never throws. `SpecsService` calls this without awaiting it: a spec's own
   * state is already committed by then, and nothing Jira does should be able
   * to affect it.
   */
  async mirrorSpecTransition(input: {
    projectId: string;
    ticketId: string;
    specId: string;
    to: SpecStatus;
  }): Promise<MirrorOutcome[]> {
    const [ticket] = await this.db
      .select({ key: tickets.key, source: tickets.source, externalKey: tickets.externalKey })
      .from(tickets)
      .where(eq(tickets.id, input.ticketId))
      .limit(1);

    const issueKey = ticket?.externalKey ?? null;
    if (!ticket || ticket.source !== 'jira' || !issueKey) return [];

    const link = await this.specUrl(input.projectId, input.specId);
    const outcomes = [
      await this.commentSpecLink({
        projectId: input.projectId,
        issueKey,
        text: describeTransition(input.to, link),
      }),
      await this.mirrorStatus({ projectId: input.projectId, issueKey, to: input.to }),
    ];

    for (const outcome of outcomes) {
      if (!outcome.ok) this.logger.log(`Jira mirror for ${issueKey}: ${outcome.detail}`);
    }
    return outcomes;
  }

  /** Where a person clicking from Jira should land. */
  private async specUrl(projectId: string, specId: string): Promise<string> {
    const [project] = await this.db
      .select({ slug: projects.slug })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    const origin = this.config.webOrigin.replace(/\/+$/, '');
    return project ? `${origin}/p/${project.slug}?spec=${specId}` : origin;
  }

  /**
   * Run a mirror call, swallowing anything it throws.
   *
   * The swallow is the point, not an oversight: see rule 1 above. What went
   * wrong still surfaces — as a returned description the caller logs against
   * the spec, and in the server log — but never as a thrown error that could
   * roll back a local transition.
   */
  private async bestEffort(
    what: string,
    issueKey: string,
    fn: () => Promise<MirrorOutcome>,
  ): Promise<MirrorOutcome> {
    try {
      return await fn();
    } catch (err) {
      const message =
        err instanceof JiraError ? err.message : err instanceof Error ? err.message : String(err);
      this.logger.warn(`Jira ${what} for ${issueKey} failed: ${message}`);
      return { ok: false, detail: `Jira ${what} failed: ${message.slice(0, 200)}` };
    }
  }
}

/**
 * What the comment says.
 *
 * Written for someone who lives in Jira and has never opened specd: it names
 * what happened, and where to go. The approval line is deliberately the most
 * specific — a reader in Jira should be able to tell that a person stamped
 * this, not a bot, because that distinction is the product.
 */
export function describeTransition(to: SpecStatus, link: string): string {
  const lines: Record<string, string> = {
    draft: 'specd drafted a spec for this issue — requirements, design and tasks, grounded in the repository’s knowledge base.',
    in_review: 'The spec for this issue is in review.',
    changes_requested: 'Changes were requested on this issue’s spec.',
    approved: 'The spec for this issue was **approved by a person** in specd. Implementation can start.',
    building: 'A build agent is implementing this issue’s approved spec. It will open a pull request.',
    delivered: 'This issue’s spec was delivered — the work merged, and the as-built spec is now in the repository’s knowledge base.',
    blocked: 'This issue’s spec is blocked on an open question.',
  };

  return `${lines[to] ?? `This issue’s spec moved to "${to}".`}\n\n${link}`;
}
