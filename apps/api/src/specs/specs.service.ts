import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, max } from 'drizzle-orm';
import { specComments, specs, tickets, type Db } from '@specd/db';
import {
  BUILDABLE_STATUSES,
  canTransition,
  columnForStatus,
  countCitations,
  countUnverified,
  isHumanOnlyStatus,
  renderSpecMarkdown,
  type SpecContent,
  type SpecStatus,
  type SpecView,
} from '@specd/shared';
import { DB } from '../db/db.module.js';
import { SpecNotApproved } from '../common/errors.js';

@Injectable()
export class SpecsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Creates the next version of a ticket's spec. Versions are append-only:
   * v2 supersedes v1, and v1 stays exactly as it was approved or rejected
   * (§10). Rewriting history would destroy the audit story the gate exists
   * to produce.
   */
  async createVersion(input: {
    projectId: string;
    ticketId: string;
    content: SpecContent;
    createdByRunId?: string | null;
  }): Promise<SpecView> {
    const [latest] = await this.db
      .select({ version: max(specs.version), id: specs.id })
      .from(specs)
      .where(eq(specs.ticketId, input.ticketId))
      .groupBy(specs.id)
      .orderBy(desc(specs.version))
      .limit(1);

    const nextVersion = (latest?.version ?? 0) + 1;

    const [row] = await this.db
      .insert(specs)
      .values({
        projectId: input.projectId,
        ticketId: input.ticketId,
        version: nextVersion,
        status: 'draft',
        content: input.content,
        citationCount: countCitations(input.content),
        unverifiedCount: countUnverified(input.content),
        supersedesId: latest?.id ?? null,
        createdByRunId: input.createdByRunId ?? null,
      })
      .returning();

    if (!row) throw new Error('failed to create spec version');

    await this.syncTicketColumn(input.ticketId, 'draft');
    return this.toView(row);
  }

  async latestForTicket(ticketId: string): Promise<SpecView | null> {
    const [row] = await this.db
      .select()
      .from(specs)
      .where(eq(specs.ticketId, ticketId))
      .orderBy(desc(specs.version))
      .limit(1);
    return row ? this.toView(row) : null;
  }

  async versionsForTicket(ticketId: string): Promise<SpecView[]> {
    const rows = await this.db
      .select()
      .from(specs)
      .where(eq(specs.ticketId, ticketId))
      .orderBy(desc(specs.version));
    return Promise.all(rows.map((r) => this.toView(r)));
  }

  async byId(projectId: string, specId: string): Promise<SpecView> {
    const [row] = await this.db
      .select()
      .from(specs)
      .where(and(eq(specs.id, specId), eq(specs.projectId, projectId)))
      .limit(1);
    if (!row) throw new NotFoundException('Spec not found');
    return this.toView(row);
  }

  /**
   * Every status change funnels through here. The state machine is the gate:
   * illegal transitions are refused, and `approved` is refused outright to any
   * caller that is not a named human.
   */
  async transition(input: {
    projectId: string;
    specId: string;
    to: SpecStatus;
    actor: { userId: string; name: string } | null;
  }): Promise<SpecView> {
    const current = await this.byId(input.projectId, input.specId);

    if (!canTransition(current.status, input.to)) {
      throw new BadRequestException(
        `Cannot move a spec from "${current.status}" to "${input.to}".`,
      );
    }

    if (isHumanOnlyStatus(input.to) && !input.actor) {
      // This is the contract the whole product exists to keep. An agent path
      // reaching here is a bug, and it fails loudly rather than quietly.
      throw new ForbiddenException(
        'Approval must be performed by a signed-in human. Agents never approve their own input.',
      );
    }

    const patch: Record<string, unknown> = { status: input.to, updatedAt: new Date() };
    if (input.to === 'approved' && input.actor) {
      patch.approvedByUserId = input.actor.userId;
      patch.approvedByName = input.actor.name;
      patch.approvedAt = new Date();
    }

    const [row] = await this.db
      .update(specs)
      .set(patch)
      .where(eq(specs.id, input.specId))
      .returning();
    if (!row) throw new NotFoundException('Spec not found');

    await this.syncTicketColumn(row.ticketId, input.to);
    return this.toView(row);
  }

  /**
   * The CLI's read path. Approved-only, enforced server-side so a thin client
   * cannot route around the gate (D13).
   */
  async pullMarkdown(projectId: string, ticketKeyOrSpecId: string): Promise<string> {
    const spec = await this.resolveForPull(projectId, ticketKeyOrSpecId);

    if (!BUILDABLE_STATUSES.includes(spec.status)) {
      throw new SpecNotApproved(spec.status);
    }

    return renderSpecMarkdown({
      ticketKey: spec.ticketKey,
      title: spec.title,
      version: spec.version,
      status: spec.status,
      approvedBy: spec.approvedBy,
      approvedAt: spec.approvedAt,
      content: spec.content,
    });
  }

  async statusOf(projectId: string, ticketKeyOrSpecId: string) {
    const spec = await this.resolveForPull(projectId, ticketKeyOrSpecId);
    return {
      id: spec.id,
      ticketKey: spec.ticketKey,
      title: spec.title,
      version: spec.version,
      status: spec.status,
      approvedBy: spec.approvedBy,
      approvedAt: spec.approvedAt,
      buildable: BUILDABLE_STATUSES.includes(spec.status),
    };
  }

  private async resolveForPull(projectId: string, ref: string): Promise<SpecView> {
    // Accept either a spec id or a ticket key — `specd spec pull CRM-131` is
    // what a human will actually type.
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);

    if (isUuid) return this.byId(projectId, ref);

    const [ticket] = await this.db
      .select({ id: tickets.id })
      .from(tickets)
      .where(and(eq(tickets.projectId, projectId), eq(tickets.key, ref.toUpperCase())))
      .limit(1);

    if (!ticket) throw new NotFoundException(`No ticket or spec "${ref}" in this project`);

    const spec = await this.latestForTicket(ticket.id);
    if (!spec) throw new NotFoundException(`Ticket ${ref} has no spec yet`);
    return spec;
  }

  async addComment(input: {
    specId: string;
    section: string;
    authorUserId: string;
    authorName: string;
    body: string;
  }) {
    const [row] = await this.db.insert(specComments).values(input).returning();
    return row!;
  }

  async comments(specId: string) {
    return this.db
      .select()
      .from(specComments)
      .where(eq(specComments.specId, specId))
      .orderBy(specComments.createdAt);
  }

  /** Review threads become the input to the next draft (§8 stage 3). */
  async revisionNotes(specId: string): Promise<string[]> {
    const rows = await this.comments(specId);
    return rows.map((r) => `[${r.section}] ${r.authorName}: ${r.body}`);
  }

  async listByProject(projectId: string) {
    return this.db
      .select()
      .from(specs)
      .where(eq(specs.projectId, projectId))
      .orderBy(desc(specs.createdAt));
  }

  private async syncTicketColumn(ticketId: string, status: SpecStatus): Promise<void> {
    await this.db
      .update(tickets)
      .set({ columnKey: columnForStatus(status), updatedAt: new Date() })
      .where(eq(tickets.id, ticketId));
  }

  private async toView(row: typeof specs.$inferSelect): Promise<SpecView> {
    const [ticket] = await this.db
      .select({ key: tickets.key, title: tickets.title })
      .from(tickets)
      .where(eq(tickets.id, row.ticketId))
      .limit(1);

    return {
      id: row.id,
      ticketId: row.ticketId,
      ticketKey: ticket?.key ?? '',
      title: ticket?.title ?? '',
      version: row.version,
      status: row.status as SpecStatus,
      content: row.content,
      citationCount: row.citationCount,
      unverifiedCount: row.unverifiedCount,
      approvedBy: row.approvedByName,
      approvedAt: row.approvedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      supersedes: row.supersedesId,
    };
  }
}
