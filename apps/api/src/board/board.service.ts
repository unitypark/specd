import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { agentRuns, specs, tickets, type Db } from '@specd/db';
import { BOARD_COLUMNS, BUILDABLE_STATUSES, type SpecStatus } from '@specd/shared';
import { RunsInFlight, TicketHasDeliveredWork } from '../common/errors.js';
import { DB } from '../db/db.module.js';

export interface BoardCard {
  id: string;
  key: string;
  title: string;
  columnKey: string;
  /** Rank within the column — what a drag-to-reorder writes. */
  position: number;
  source: string;
  externalUrl: string | null;
  assignee: string | null;
  /**
   * Last time anything about the ticket moved. The board reads it as age: a
   * card that has sat in review for three weeks is the thing a stand-up needs
   * to see, and a board that cannot show it is a list with columns.
   */
  updatedAt: string;
  spec: {
    id: string;
    version: number;
    status: SpecStatus;
    citationCount: number;
    unverifiedCount: number;
    approvedBy: string | null;
  } | null;
}

/**
 * The built-in board. Deliberately shallow (D5): columns are the spec
 * lifecycle, plus drag, labels and assignee. We are not rebuilding Jira — the
 * board exists so teams without one can start today.
 */
@Injectable()
export class BoardService {
  constructor(@Inject(DB) private readonly db: Db) {}

  columns() {
    return BOARD_COLUMNS;
  }

  async cards(projectId: string): Promise<BoardCard[]> {
    const rows = await this.db
      .select({
        ticket: tickets,
        spec: specs,
      })
      .from(tickets)
      .leftJoin(
        specs,
        and(
          eq(specs.ticketId, tickets.id),
          // Only the newest version drives the card.
          eq(
            specs.version,
            sql`(SELECT max(version) FROM specs s2 WHERE s2.ticket_id = ${tickets.id})`,
          ),
        ),
      )
      .where(eq(tickets.projectId, projectId))
      .orderBy(tickets.position, tickets.createdAt);

    return rows.map(({ ticket, spec }) => ({
      id: ticket.id,
      key: ticket.key,
      title: ticket.title,
      columnKey: ticket.columnKey,
      position: ticket.position,
      source: ticket.source,
      externalUrl: ticket.externalUrl,
      assignee: ticket.assignee,
      updatedAt: ticket.updatedAt.toISOString(),
      spec: spec
        ? {
            id: spec.id,
            version: spec.version,
            status: spec.status as SpecStatus,
            citationCount: spec.citationCount,
            unverifiedCount: spec.unverifiedCount,
            approvedBy: spec.approvedByName,
          }
        : null,
    }));
  }

  async createTicket(input: {
    projectId: string;
    keyPrefix: string;
    title: string;
    body?: string;
    assignee?: string | null;
  }) {
    const key = await this.nextKey(input.projectId, input.keyPrefix);

    const [row] = await this.db
      .insert(tickets)
      .values({
        projectId: input.projectId,
        key,
        title: input.title,
        body: input.body ?? '',
        assignee: input.assignee ?? null,
        columnKey: 'backlog',
        position: await this.nextPosition(input.projectId, 'backlog'),
      })
      .returning();

    if (!row) throw new Error('failed to create ticket');
    return row;
  }

  /**
   * Rewrite the rank of one column from the order the client is showing.
   *
   * Within a lane, order is priority — the one piece of board state the
   * lifecycle does not already decide for you, and the reason `position`
   * exists. The contract is deliberately total: the named tickets take ranks
   * 0..n-1 and everything else in the lane keeps its relative order behind
   * them. A ticket someone else added between this client's last load and its
   * drop therefore lands at the bottom instead of failing the request — a
   * board that refuses a drag because a colleague was typing is worse than one
   * that puts a brand-new ticket one row lower than expected.
   *
   * `updatedAt` is deliberately not touched. The board reads that field as
   * "when did this work last move", and dragging a card up the backlog is not
   * work moving — bumping it would make every reprioritised card look freshly
   * worked on, which is exactly the lie the age marker exists to catch.
   */
  async reorder(projectId: string, columnKey: string, ticketIds: string[]): Promise<void> {
    const rows = await this.db
      .select({ id: tickets.id })
      .from(tickets)
      .where(and(eq(tickets.projectId, projectId), eq(tickets.columnKey, columnKey)))
      .orderBy(tickets.position, tickets.createdAt);

    const inColumn = new Set(rows.map((r) => r.id));
    const named = ticketIds.filter((id) => inColumn.has(id));
    const rest = rows.map((r) => r.id).filter((id) => !named.includes(id));
    const ordered = [...named, ...rest];
    if (ordered.length === 0) return;

    await this.db.transaction(async (tx) => {
      for (const [index, id] of ordered.entries()) {
        await tx.update(tickets).set({ position: index }).where(eq(tickets.id, id));
      }
    });
  }

  /** One past the last rank in a column, so a new ticket lands at the bottom. */
  private async nextPosition(projectId: string, columnKey: string): Promise<number> {
    const [row] = await this.db
      .select({ max: sql<number | null>`max(${tickets.position})` })
      .from(tickets)
      .where(and(eq(tickets.projectId, projectId), eq(tickets.columnKey, columnKey)));
    return (row?.max ?? -1) + 1;
  }

  /**
   * Bring Jira issues onto the board as tickets, without duplicating them.
   *
   * An imported ticket keeps its **Jira key** as its own key, so `specd spec
   * pull AUR-142` reads the same whether the work came from Jira or was
   * written here. Re-importing updates title and body rather than inserting a
   * second copy — the Jira issue is the record, this is a projection of it,
   * and the local `columnKey` is left exactly where the team dragged it.
   */
  async importExternal(input: {
    projectId: string;
    source: 'jira';
    issues: { key: string; summary: string; description: string; url: string }[];
  }): Promise<{ imported: number; updated: number }> {
    let imported = 0;
    let updated = 0;

    for (const issue of input.issues) {
      const [existing] = await this.db
        .select({ id: tickets.id })
        .from(tickets)
        .where(and(eq(tickets.projectId, input.projectId), eq(tickets.key, issue.key)))
        .limit(1);

      if (existing) {
        await this.db
          .update(tickets)
          .set({ title: issue.summary, body: issue.description, updatedAt: new Date() })
          .where(eq(tickets.id, existing.id));
        updated += 1;
        continue;
      }

      await this.db.insert(tickets).values({
        projectId: input.projectId,
        key: issue.key,
        title: issue.summary,
        body: issue.description,
        source: input.source,
        externalKey: issue.key,
        externalUrl: issue.url,
        columnKey: 'backlog',
        // Imports queue behind whatever the team has already ranked, rather
        // than landing on top of a prioritised backlog.
        position: await this.nextPosition(input.projectId, 'backlog'),
      });
      imported += 1;
    }

    return { imported, updated };
  }

  async get(projectId: string, ticketId: string) {
    const [row] = await this.db
      .select()
      .from(tickets)
      .where(and(eq(tickets.id, ticketId), eq(tickets.projectId, projectId)))
      .limit(1);
    if (!row) throw new NotFoundException('Ticket not found');
    return row;
  }

  async byKey(projectId: string, key: string) {
    const [row] = await this.db
      .select()
      .from(tickets)
      .where(and(eq(tickets.projectId, projectId), eq(tickets.key, key.toUpperCase())))
      .limit(1);
    return row ?? null;
  }

  async update(
    projectId: string,
    ticketId: string,
    patch: { title?: string; body?: string; assignee?: string | null; columnKey?: string },
  ) {
    await this.get(projectId, ticketId);
    const [row] = await this.db
      .update(tickets)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(tickets.id, ticketId))
      .returning();
    return row!;
  }

  /**
   * A ticket can be deleted while it is still just an intention — no spec,
   * or drafts that never reached the gate (those cascade away with it). Once
   * a spec is approved, building or delivered, the ticket is part of the
   * audit trail and deletion is refused; run history survives either way
   * because `agent_runs.ticket_id` nulls rather than cascades.
   */
  async removeTicket(projectId: string, ticketId: string): Promise<void> {
    await this.get(projectId, ticketId);

    const [gated] = await this.db
      .select({ status: specs.status })
      .from(specs)
      .where(and(eq(specs.ticketId, ticketId), inArray(specs.status, [...BUILDABLE_STATUSES])))
      .limit(1);
    if (gated) throw new TicketHasDeliveredWork(gated.status);

    const [running] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(agentRuns)
      .where(and(eq(agentRuns.ticketId, ticketId), eq(agentRuns.status, 'running')));
    const runningCount = Number(running?.n ?? 0);
    if (runningCount > 0) throw new RunsInFlight('ticket', runningCount);

    await this.db.delete(tickets).where(eq(tickets.id, ticketId));
  }

  /** CRM-142 — sequential per project, so keys read like a tracker's. */
  private async nextKey(projectId: string, prefix: string): Promise<string> {
    const existing = await this.db
      .select({ key: tickets.key })
      .from(tickets)
      .where(eq(tickets.projectId, projectId));

    const pattern = new RegExp(`^${prefix}-(\\d+)$`);
    let highest = 100;
    for (const { key } of existing) {
      const n = pattern.exec(key)?.[1];
      if (n) highest = Math.max(highest, Number(n));
    }
    return `${prefix}-${highest + 1}`;
  }

  /** Uppercased initials of the project name: "Aurora CRM" → "AC". */
  static keyPrefix(projectName: string): string {
    const letters = projectName
      .split(/\s+/)
      .map((word) => word[0])
      .filter((char): char is string => char !== undefined && /[a-z]/i.test(char))
      .join('')
      .toUpperCase();
    return (letters || 'SPEC').slice(0, 4);
  }
}
