import { canTransition, isHumanOnlyStatus, type SpecStatus } from '@specd/shared';

/**
 * The board's lifecycle rules, kept out of the view that draws them.
 *
 * This is domain logic, not rendering: which moves the board permits is one of
 * the product's load-bearing guarantees, and it deserves to be readable and
 * testable without mounting a 700-line component around it.
 */

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
  if (!card.spec) return { ok: false, reason: `${card.key} has no spec yet — generate one first.` };
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
