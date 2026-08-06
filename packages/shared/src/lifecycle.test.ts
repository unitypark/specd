import { describe, expect, it } from 'vitest';
import {
  BUILDABLE_STATUSES,
  SPEC_STATUSES,
  allowedTransitions,
  canTransition,
  columnForStatus,
  isHumanOnlyStatus,
  type SpecStatus,
} from './lifecycle.js';

describe('spec lifecycle', () => {
  it('walks the happy path', () => {
    const path: SpecStatus[] = ['draft', 'in_review', 'approved', 'building', 'delivered'];
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it('supports a review round trip', () => {
    expect(canTransition('in_review', 'changes_requested')).toBe(true);
    expect(canTransition('changes_requested', 'in_review')).toBe(true);
  });

  it('refuses to un-approve in place', () => {
    // Approval is a recorded act pinned to a version. Walking it back would
    // erase the audit story — a new version is the only way forward.
    expect(canTransition('approved', 'draft')).toBe(false);
    expect(canTransition('approved', 'in_review')).toBe(false);
    expect(canTransition('approved', 'changes_requested')).toBe(false);
  });

  it('refuses to skip the gate', () => {
    expect(canTransition('draft', 'approved')).toBe(false);
    expect(canTransition('draft', 'building')).toBe(false);
    expect(canTransition('changes_requested', 'approved')).toBe(false);
  });

  it('treats delivered as terminal', () => {
    expect(allowedTransitions('delivered')).toHaveLength(0);
  });

  it('marks only approval as human-only', () => {
    const humanOnly = SPEC_STATUSES.filter(isHumanOnlyStatus);
    expect(humanOnly).toEqual(['approved']);
  });

  it('only lets approved-or-later specs reach a coding agent', () => {
    expect(BUILDABLE_STATUSES).toEqual(['approved', 'building', 'delivered']);
    for (const status of ['draft', 'in_review', 'changes_requested', 'blocked'] as SpecStatus[]) {
      expect(BUILDABLE_STATUSES).not.toContain(status);
    }
  });

  it('maps every status to a board column', () => {
    for (const status of SPEC_STATUSES) {
      expect(columnForStatus(status)).toBeTruthy();
    }
    expect(columnForStatus(null)).toBe('backlog');
    expect(columnForStatus('changes_requested')).toBe('review');
    expect(columnForStatus('delivered')).toBe('done');
  });
});
