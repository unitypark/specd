import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { specs, tickets, type Db } from '@specd/db';
import { BOARD_COLUMNS, type SpecStatus } from '@specd/shared';
import { DB } from '../db/db.module.js';

export interface BoardCard {
  id: string;
  key: string;
  title: string;
  columnKey: string;
  source: string;
  externalUrl: string | null;
  assignee: string | null;
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
      source: ticket.source,
      externalUrl: ticket.externalUrl,
      assignee: ticket.assignee,
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
      })
      .returning();

    if (!row) throw new Error('failed to create ticket');
    return row;
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
