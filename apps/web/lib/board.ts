import { canTransition, isHumanOnlyStatus, type SpecStatus } from '@specd/shared';

/**
 * The board's lifecycle rules, kept out of the view that draws them.
 *
 * This is domain logic, not rendering: which moves the board permits is one of
 * the product's load-bearing guarantees, and it deserves to be readable and
 * testable without mounting a 700-line component around it. Everything the
 * board decides *about a card* — is it flagged, is it stuck, how old is it,
 * where can it go next — lives here too, for the same reason.
 */

export interface BoardCard {
  id: string;
  key: string;
  title: string;
  columnKey: string;
  position: number;
  /** native | jira */
  source: string;
  externalUrl: string | null;
  assignee: string | null;
  updatedAt: string;
  spec: {
    id: string;
    version: number;
    status: string;
    citationCount: number;
    unverifiedCount: number;
    approvedBy: string | null;
  } | null;
}

/**
 * Which spec status a board column represents. `backlog` has none — a ticket
 * with no spec yet cannot be transitioned anywhere.
 */
export const COLUMN_STATUS: Record<string, SpecStatus | null> = {
  backlog: null,
  draft: 'draft',
  review: 'in_review',
  approved: 'approved',
  building: 'building',
  done: 'delivered',
};

/**
 * What each lane is waiting for, shown when the lane is empty. A dash tells a
 * reader nothing; "nothing waiting on a reviewer" tells them the queue is
 * clear, which is the actual news.
 */
export const COLUMN_EMPTY: Record<string, string> = {
  backlog: 'No tickets yet. Add the business ask in plain language.',
  draft: 'No drafts. Generate a spec from a backlog ticket.',
  review: 'Nothing waiting on a reviewer.',
  approved: 'Nothing stamped and ready to build.',
  building: 'No builds in flight.',
  done: 'Nothing delivered yet.',
};

export interface DroppableCard {
  key: string;
  spec: { status: string } | null;
}

/**
 * Whether a card may be dragged into a column, and why not if it may not.
 *
 * The important case is `approved`. Dragging is a cheap, easily mistaken
 * gesture, and approval is the one act this product exists to make deliberate
 * and attributable — so the gate is closed to drag entirely and stays behind
 * the explicit button in the drawer. The server would refuse an unattributed
 * approval anyway; refusing here means the user gets a reason instead of a 403.
 */
export function dropCheck(
  card: DroppableCard,
  toColumn: string,
): { ok: boolean; reason?: string } {
  const to = COLUMN_STATUS[toColumn];
  if (!card.spec) {
    // A ticket with no spec lives in the backlog and cannot leave it. Dropping
    // it back where it already is is not a lifecycle move at all, though — it
    // is ranking, and a backlog you cannot prioritise is a list.
    return toColumn === 'backlog'
      ? { ok: true }
      : { ok: false, reason: `${card.key} has no spec yet — generate one first.` };
  }
  if (to === null) return { ok: false, reason: 'A spec cannot go back to the backlog.' };
  if (to === undefined) return { ok: false, reason: 'Unknown column.' };

  const from = card.spec.status as SpecStatus;
  if (from === to) return { ok: true };

  if (isHumanOnlyStatus(to)) {
    return {
      ok: false,
      reason: 'Approving is not a drag. Open the spec and stamp it — the approval is recorded against you.',
    };
  }
  if (!canTransition(from, to)) {
    return { ok: false, reason: `${card.key} cannot move from "${from}" to "${to}".` };
  }
  return { ok: true };
}

/**
 * What dropping this card on that lane actually means.
 *
 * The distinction is load-bearing, and `dropCheck` alone cannot draw it: two
 * statuses share a lane with another (`blocked` sits in Spec draft,
 * `changes_requested` in In review), and both have a legal transition to the
 * status their own lane stands for. Asking `dropCheck` about the lane a card
 * is already in therefore answers "yes, allowed" — and acting on that would
 * silently submit a card for review because someone nudged it up its own lane.
 * A drop that does not change lane is only ever ranking.
 */
export type DropPlan =
  | { kind: 'rank' }
  | { kind: 'move'; to: SpecStatus; specId: string }
  | { kind: 'refuse'; reason: string };

export function planDrop(card: BoardCard, toColumn: string): DropPlan {
  if (toColumn === card.columnKey) return { kind: 'rank' };

  const check = dropCheck(card, toColumn);
  if (!check.ok) return { kind: 'refuse', reason: check.reason ?? 'That move is not allowed.' };

  const to = COLUMN_STATUS[toColumn];
  // The plan carries the spec id rather than making the caller reach back for
  // it: `dropCheck` has already established there is one, and a caller that
  // has to re-derive that is a caller that can get it wrong.
  return to && card.spec
    ? { kind: 'move', to, specId: card.spec.id }
    : { kind: 'refuse', reason: 'A spec cannot go back to the backlog.' };
}

/**
 * The lane one step left or right, if the card is allowed to go there.
 *
 * Deliberately only the *immediate* neighbour: skipping over an illegal lane
 * to find a legal one further along would make one arrow press jump two lanes,
 * and the gate — which is exactly such an illegal lane — is the last place the
 * board should be clever. Keyboard movement and drag therefore obey the same
 * rule, and neither can reach `approved`.
 */
export function neighbourColumn(
  columnKeys: readonly string[],
  card: DroppableCard & { columnKey: string },
  direction: -1 | 1,
): { key: string; reason?: string } | null {
  const at = columnKeys.indexOf(card.columnKey);
  const next = columnKeys[at + direction];
  if (at === -1 || next === undefined) return null;
  const check = dropCheck(card, next);
  return check.ok ? { key: next } : { key: next, reason: check.reason };
}

// ─── attention ──────────────────────────────────────────────────────────────

/** A claim nobody has checked is sitting in this spec. */
export function isFlagged(card: BoardCard): boolean {
  return (card.spec?.unverifiedCount ?? 0) > 0;
}

/**
 * The card is stopped until a person does something: an open business question
 * (`blocked`) or a reviewer who asked for changes (`changes_requested`).
 */
export function needsWork(card: BoardCard): boolean {
  return card.spec?.status === 'blocked' || card.spec?.status === 'changes_requested';
}

/**
 * The sub-state its own lane cannot show.
 *
 * Two statuses share a lane with another: `blocked` sits in Spec draft and
 * `changes_requested` sits in In review. Without a chip they are invisible —
 * a card stuck on an unanswered question looks exactly like one being actively
 * drafted, which is the single worst thing a board can get wrong.
 */
export function subStatus(card: BoardCard): string | null {
  switch (card.spec?.status) {
    case 'blocked':
      return 'blocked';
    case 'changes_requested':
      return 'changes requested';
    default:
      return null;
  }
}

// ─── age ────────────────────────────────────────────────────────────────────

const DAY = 86_400_000;

/**
 * How long since anything happened to this ticket, as a lane-width label.
 *
 * `stale` is only ever true off the terminal lane: a delivered card sitting
 * untouched for a year is finished, not neglected, and marking it would train
 * people to ignore the marker everywhere else.
 */
export function age(
  card: BoardCard,
  now: number = Date.now(),
): { days: number; label: string; stale: boolean } | null {
  const then = Date.parse(card.updatedAt);
  if (Number.isNaN(then)) return null;
  const days = Math.max(0, Math.floor((now - then) / DAY));

  const label =
    days < 1
      ? 'today'
      : days < 7
        ? `${days}d`
        : days < 60
          ? `${Math.floor(days / 7)}w`
          : `${Math.floor(days / 30)}mo`;

  return { days, label, stale: days >= 14 && card.columnKey !== 'done' };
}

// ─── filtering ──────────────────────────────────────────────────────────────

/** Stands in for "nobody" in the assignee filter — no real name can collide. */
export const UNASSIGNED = ' none';

export type Attention = 'any' | 'flagged' | 'needs-work';

export interface BoardFilters {
  query: string;
  /** Empty means every assignee; otherwise an allow-list of names. */
  assignees: string[];
  attention: Attention;
}

export const NO_FILTERS: BoardFilters = { query: '', assignees: [], attention: 'any' };

export function filtersActive(f: BoardFilters): boolean {
  return f.query.trim() !== '' || f.assignees.length > 0 || f.attention !== 'any';
}

export function matchesFilters(card: BoardCard, f: BoardFilters): boolean {
  const q = f.query.trim().toLowerCase();
  if (q) {
    const haystack = `${card.key} ${card.title} ${card.assignee ?? ''}`.toLowerCase();
    // Every word must appear somewhere, in any order — "crm export" finds
    // "CRM-142 Export contacts" the way a person expects it to.
    if (!q.split(/\s+/).every((word) => haystack.includes(word))) return false;
  }

  if (f.assignees.length > 0 && !f.assignees.includes(card.assignee ?? UNASSIGNED)) return false;

  if (f.attention === 'flagged' && !isFlagged(card)) return false;
  if (f.attention === 'needs-work' && !needsWork(card)) return false;

  return true;
}

/** Who appears on this board, busiest first, with the unassigned pile last. */
export function assigneeOptions(
  cards: BoardCard[],
): { value: string; label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const card of cards) {
    const key = card.assignee ?? UNASSIGNED;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const named = [...counts.entries()]
    .filter(([value]) => value !== UNASSIGNED)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value, count]) => ({ value, label: value, count }));

  const none = counts.get(UNASSIGNED);
  return none ? [...named, { value: UNASSIGNED, label: 'Unassigned', count: none }] : named;
}

/** "JH" for Jung Hwa Park, "A" for anna — the avatar when there is no photo. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const letters = words.slice(0, 2).map((w) => [...w][0] ?? '');
  return letters.join('').toUpperCase();
}

// ─── ordering ───────────────────────────────────────────────────────────────

/** Move one item to a new index, returning a new array. */
export function reorder<T>(items: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= items.length) return [...items];
  const next = [...items];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return [...items];
  next.splice(Math.max(0, Math.min(to, next.length)), 0, moved);
  return next;
}

/**
 * Where a card dropped at `y` should be inserted, given each existing card's
 * vertical midpoint. Above a card's midpoint means before it — the rule every
 * board uses, extracted so the arithmetic can be tested without a pointer.
 */
export function insertionIndex(midpoints: readonly number[], y: number): number {
  const at = midpoints.findIndex((mid) => y < mid);
  return at === -1 ? midpoints.length : at;
}

/** The cards in one lane, in the order the board is showing them. */
export function lane(cards: readonly BoardCard[], columnKey: string): BoardCard[] {
  return cards.filter((c) => c.columnKey === columnKey);
}

/**
 * The board as it looks the instant a card is dropped, before the server has
 * agreed.
 *
 * A board that waits for a round-trip feels broken, so the card lands where it
 * was dropped and snaps back if the server disagrees. Ordering *between* lanes
 * is not meaningful — every lane is rendered by filtering this array — so the
 * moved lane is simply rebuilt and appended, which keeps the operation a pure
 * function of the array rather than an in-place splice with an index to get
 * wrong.
 */
export function placeInColumn(
  cards: readonly BoardCard[],
  cardId: string,
  toColumn: string,
  index: number,
): BoardCard[] {
  const moving = cards.find((c) => c.id === cardId);
  if (!moving) return [...cards];

  const target = cards.filter((c) => c.columnKey === toColumn && c.id !== cardId);
  target.splice(Math.max(0, Math.min(index, target.length)), 0, { ...moving, columnKey: toColumn });

  return [...cards.filter((c) => c.columnKey !== toColumn && c.id !== cardId), ...target];
}
