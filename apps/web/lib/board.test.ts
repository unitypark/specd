import { describe, expect, it } from 'vitest';
import {
  COLUMN_STATUS,
  NO_FILTERS,
  UNASSIGNED,
  age,
  assigneeOptions,
  dropCheck,
  filtersActive,
  initials,
  insertionIndex,
  lane,
  matchesFilters,
  needsWork,
  neighbourColumn,
  placeInColumn,
  planDrop,
  reorder,
  subStatus,
  type BoardCard,
} from './board.js';

/**
 * The board's guarantees, tested where they live rather than through the
 * component that draws them. The one that matters most is that approval is
 * not reachable by dragging: the server refuses an unattributed approval
 * regardless, but a user deserves a reason rather than a 403.
 */

const card = (status: string | null) => ({
  key: 'CRM-131',
  spec: status === null ? null : { status },
});

const COLUMNS = ['backlog', 'draft', 'review', 'approved', 'building', 'done'];

let seq = 0;
function boardCard(over: Partial<BoardCard> & { status?: string | null } = {}): BoardCard {
  const { status = 'draft', ...rest } = over;
  seq += 1;
  return {
    id: `id-${seq}`,
    key: `CRM-${100 + seq}`,
    title: 'Export contacts to Excel',
    columnKey: 'draft',
    position: 0,
    source: 'native',
    externalUrl: null,
    assignee: null,
    updatedAt: new Date('2026-08-12T00:00:00Z').toISOString(),
    spec:
      status === null
        ? null
        : {
            id: `spec-${seq}`,
            version: 1,
            status,
            citationCount: 3,
            unverifiedCount: 0,
            approvedBy: null,
          },
    ...rest,
  };
}

describe('dropCheck', () => {
  it('refuses to approve by drag, and says why', () => {
    const result = dropCheck(card('in_review'), 'approved');
    expect(result.ok).toBe(false);
    // The reason has to point at the thing that *is* allowed, or it is just a
    // refusal. "Stamp it in the drawer" is the whole instruction.
    expect(result.reason).toMatch(/not a drag/i);
    expect(result.reason).toMatch(/open the spec/i);
  });

  it('refuses to approve by drag from every column, not just review', () => {
    for (const from of ['draft', 'in_review', 'changes_requested']) {
      expect(dropCheck(card(from), 'approved').ok).toBe(false);
    }
  });

  it('refuses a ticket with no spec, and points at generating one', () => {
    const result = dropCheck(card(null), 'draft');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('CRM-131');
    expect(result.reason).toMatch(/generate one first/i);
  });

  it('lets a ticket with no spec be ranked inside the backlog it already lives in', () => {
    // Otherwise a backlog is a list: the one board gesture that means anything
    // for a spec-less ticket is moving it up or down the queue.
    expect(dropCheck(card(null), 'backlog').ok).toBe(true);
  });

  it('refuses to send a spec back to the backlog', () => {
    const result = dropCheck(card('draft'), 'backlog');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/cannot go back to the backlog/i);
  });

  it('refuses an unknown column rather than silently allowing it', () => {
    const result = dropCheck(card('draft'), 'not-a-column');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('Unknown column.');
  });

  it('allows a drop onto the column the card is already in', () => {
    expect(dropCheck(card('draft'), 'draft').ok).toBe(true);
  });

  it('allows a legal lifecycle move and refuses an illegal one with both states named', () => {
    expect(dropCheck(card('draft'), 'review').ok).toBe(true);

    const illegal = dropCheck(card('delivered'), 'draft');
    expect(illegal.ok).toBe(false);
    expect(illegal.reason).toContain('delivered');
    expect(illegal.reason).toContain('draft');
  });

  it('maps every column the board renders to a status, or explicitly to null', () => {
    // A column missing from this map would be `undefined` and read as "Unknown
    // column" at runtime — a silent dead column rather than a loud failure.
    expect(Object.keys(COLUMN_STATUS).sort()).toEqual([...COLUMNS].sort());
    expect(COLUMN_STATUS.backlog).toBeNull();
  });
});

describe('planDrop', () => {
  it('treats a drop on the card’s own lane as ranking, never as a transition', () => {
    // The trap: `changes_requested` sits in the review lane, and
    // changes_requested → in_review is a legal transition. Asking dropCheck
    // alone would say "allowed" and quietly resubmit the spec for review
    // because someone nudged the card up its own column.
    const stuck = boardCard({ status: 'changes_requested', columnKey: 'review' });
    expect(planDrop(stuck, 'review')).toEqual({ kind: 'rank' });

    const blocked = boardCard({ status: 'blocked', columnKey: 'draft' });
    expect(planDrop(blocked, 'draft')).toEqual({ kind: 'rank' });
  });

  it('carries the spec id a real transition needs', () => {
    const drafted = boardCard({ status: 'draft', columnKey: 'draft' });
    expect(planDrop(drafted, 'review')).toEqual({
      kind: 'move',
      to: 'in_review',
      specId: drafted.spec?.id,
    });
  });

  it('refuses the gate, with the reason attached', () => {
    const reviewing = boardCard({ status: 'in_review', columnKey: 'review' });
    const plan = planDrop(reviewing, 'approved');
    expect(plan.kind).toBe('refuse');
    expect(plan.kind === 'refuse' && plan.reason).toMatch(/not a drag/i);
  });

  it('ranks a spec-less backlog ticket but will not let it leave the backlog', () => {
    const raw = boardCard({ status: null, columnKey: 'backlog' });
    expect(planDrop(raw, 'backlog')).toEqual({ kind: 'rank' });
    expect(planDrop(raw, 'draft').kind).toBe('refuse');
  });
});

describe('neighbourColumn', () => {
  it('moves one lane at a time in each direction', () => {
    const drafted = boardCard({ status: 'draft', columnKey: 'draft' });
    expect(neighbourColumn(COLUMNS, drafted, 1)).toEqual({ key: 'review' });
  });

  it('stops at the ends of the board', () => {
    const backlog = boardCard({ status: null, columnKey: 'backlog' });
    expect(neighbourColumn(COLUMNS, backlog, -1)).toBeNull();

    const done = boardCard({ status: 'delivered', columnKey: 'done' });
    expect(neighbourColumn(COLUMNS, done, 1)).toBeNull();
  });

  it('will not step over the gate, and hands back the reason instead', () => {
    // Skipping an illegal lane to find a legal one further along would make
    // one arrow press jump two lanes — and the gate is the last place the
    // board should be clever.
    const reviewing = boardCard({ status: 'in_review', columnKey: 'review' });
    const next = neighbourColumn(COLUMNS, reviewing, 1);
    expect(next?.key).toBe('approved');
    expect(next?.reason).toMatch(/not a drag/i);
  });
});

describe('card facts', () => {
  it('names the sub-state its own lane cannot show, and nothing else', () => {
    expect(subStatus(boardCard({ status: 'blocked' }))).toBe('blocked');
    expect(subStatus(boardCard({ status: 'changes_requested' }))).toBe('changes requested');
    // The lane already says "Spec draft" / "Approved" / "Done".
    for (const status of ['draft', 'in_review', 'approved', 'building', 'delivered']) {
      expect(subStatus(boardCard({ status }))).toBeNull();
    }
  });

  it('counts blocked and changes-requested as needing a person', () => {
    expect(needsWork(boardCard({ status: 'blocked' }))).toBe(true);
    expect(needsWork(boardCard({ status: 'changes_requested' }))).toBe(true);
    expect(needsWork(boardCard({ status: 'in_review' }))).toBe(false);
  });

  it('reports age at the scale the lane has room for', () => {
    const now = Date.parse('2026-08-12T12:00:00Z');
    const at = (iso: string) => age(boardCard({ updatedAt: iso }), now);

    expect(at('2026-08-12T09:00:00Z')?.label).toBe('today');
    expect(at('2026-08-09T09:00:00Z')?.label).toBe('3d');
    expect(at('2026-07-12T09:00:00Z')?.label).toBe('4w');
    expect(at('2026-02-12T09:00:00Z')?.label).toBe('6mo');
  });

  it('calls a card stale only where sitting still is a problem', () => {
    const old = '2026-05-12T09:00:00Z';
    const now = Date.parse('2026-08-12T12:00:00Z');
    expect(age(boardCard({ updatedAt: old, columnKey: 'review' }), now)?.stale).toBe(true);
    // Delivered work that has not moved in months is finished, not neglected.
    expect(age(boardCard({ updatedAt: old, columnKey: 'done' }), now)?.stale).toBe(false);
  });

  it('survives a timestamp it cannot parse', () => {
    expect(age(boardCard({ updatedAt: 'not a date' }))).toBeNull();
  });

  it('builds initials from whatever the assignee field actually holds', () => {
    expect(initials('Jung Hwa Park')).toBe('JH');
    expect(initials('anna')).toBe('A');
    expect(initials('  ')).toBe('?');
    // Free text, so it can hold anything a person typed — including an emoji.
    expect(initials('🙂 ops')).toBe('🙂O');
  });
});

describe('filters', () => {
  const cards = [
    boardCard({ key: 'CRM-101', title: 'Export contacts', assignee: 'Anna', status: 'draft' }),
    boardCard({ key: 'CRM-102', title: 'Import leads', assignee: 'Bo', status: 'in_review' }),
    boardCard({ key: 'CRM-103', title: 'Export invoices', assignee: null, status: 'blocked' }),
  ];

  it('is inactive until something is actually set', () => {
    expect(filtersActive(NO_FILTERS)).toBe(false);
    expect(filtersActive({ ...NO_FILTERS, query: '  ' })).toBe(false);
    expect(filtersActive({ ...NO_FILTERS, attention: 'flagged' })).toBe(true);
  });

  it('matches words in any order across key, title and assignee', () => {
    const q = (query: string) => cards.filter((c) => matchesFilters(c, { ...NO_FILTERS, query }));
    expect(q('export').map((c) => c.key)).toEqual(['CRM-101', 'CRM-103']);
    expect(q('contacts crm').map((c) => c.key)).toEqual(['CRM-101']);
    expect(q('anna').map((c) => c.key)).toEqual(['CRM-101']);
    expect(q('nothing here')).toEqual([]);
  });

  it('filters to named people, and to nobody at all', () => {
    const byAssignee = (assignees: string[]) =>
      cards.filter((c) => matchesFilters(c, { ...NO_FILTERS, assignees })).map((c) => c.key);

    expect(byAssignee(['Anna'])).toEqual(['CRM-101']);
    expect(byAssignee(['Anna', 'Bo'])).toEqual(['CRM-101', 'CRM-102']);
    expect(byAssignee([UNASSIGNED])).toEqual(['CRM-103']);
  });

  it('separates “nobody has checked this” from “this is stuck”', () => {
    const flagged = boardCard({ status: 'draft' });
    flagged.spec!.unverifiedCount = 2;
    const pool = [...cards, flagged];

    const attention = (value: 'flagged' | 'needs-work') =>
      pool.filter((c) => matchesFilters(c, { ...NO_FILTERS, attention: value }));

    expect(attention('flagged')).toEqual([flagged]);
    expect(attention('needs-work').map((c) => c.key)).toEqual(['CRM-103']);
  });

  it('lists who is on the board busiest first, with the unassigned pile last', () => {
    const busy = [
      boardCard({ assignee: 'Bo' }),
      boardCard({ assignee: 'Anna' }),
      boardCard({ assignee: 'Anna' }),
      boardCard({ assignee: null }),
    ];
    expect(assigneeOptions(busy)).toEqual([
      { value: 'Anna', label: 'Anna', count: 2 },
      { value: 'Bo', label: 'Bo', count: 1 },
      { value: UNASSIGNED, label: 'Unassigned', count: 1 },
    ]);
  });

  it('leaves the unassigned row out when everyone has an owner', () => {
    expect(assigneeOptions([boardCard({ assignee: 'Anna' })])).toEqual([
      { value: 'Anna', label: 'Anna', count: 1 },
    ]);
  });
});

describe('ordering', () => {
  it('moves an item without disturbing the rest', () => {
    expect(reorder(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(reorder(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(reorder(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'b', 'c']);
    expect(reorder(['a', 'b', 'c'], 9, 0)).toEqual(['a', 'b', 'c']);
  });

  it('inserts above the midpoint of the card you are hovering', () => {
    const midpoints = [50, 150, 250];
    expect(insertionIndex(midpoints, 10)).toBe(0);
    expect(insertionIndex(midpoints, 60)).toBe(1);
    expect(insertionIndex(midpoints, 260)).toBe(3);
    expect(insertionIndex([], 100)).toBe(0);
  });

  it('drops a card into a lane at the index it was released over', () => {
    const a = boardCard({ columnKey: 'draft' });
    const b = boardCard({ columnKey: 'draft' });
    const c = boardCard({ columnKey: 'review', status: 'in_review' });
    const cards = [a, b, c];

    const moved = placeInColumn(cards, c.id, 'draft', 1);
    expect(lane(moved, 'draft').map((x) => x.id)).toEqual([a.id, c.id, b.id]);
    expect(lane(moved, 'review')).toEqual([]);
    // The card is shown in its new lane immediately — the server has not been
    // asked yet.
    expect(moved.find((x) => x.id === c.id)?.columnKey).toBe('draft');
  });

  it('reorders inside one lane without duplicating the card', () => {
    const a = boardCard({ columnKey: 'draft' });
    const b = boardCard({ columnKey: 'draft' });
    const cards = [a, b];

    const moved = placeInColumn(cards, a.id, 'draft', 1);
    expect(lane(moved, 'draft').map((x) => x.id)).toEqual([b.id, a.id]);
    expect(moved).toHaveLength(2);
  });

  it('clamps an index past the end of the lane', () => {
    const a = boardCard({ columnKey: 'draft' });
    const b = boardCard({ columnKey: 'review', status: 'in_review' });
    const moved = placeInColumn([a, b], b.id, 'draft', 99);
    expect(lane(moved, 'draft').map((x) => x.id)).toEqual([a.id, b.id]);
  });

  it('leaves the board alone when asked to move a card that is not on it', () => {
    const a = boardCard({ columnKey: 'draft' });
    expect(placeInColumn([a], 'ghost', 'review', 0)).toEqual([a]);
  });
});
