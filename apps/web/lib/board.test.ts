import { describe, expect, it } from 'vitest';
import { COLUMN_STATUS, dropCheck } from './board.js';

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

describe('dropCheck', () => {
  it('refuses to approve by drag, and says why', () => {
    const result = dropCheck(card('in_review'), 'approved');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not a drag/i);
    // The reason has to point at the thing that *is* allowed, or it is just a
    // refusal. "Stamp it in the drawer" is the whole instruction.
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
    expect(Object.keys(COLUMN_STATUS).sort()).toEqual(
      ['approved', 'backlog', 'building', 'done', 'draft', 'review'].sort(),
    );
    expect(COLUMN_STATUS.backlog).toBeNull();
  });
});
