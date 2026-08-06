/**
 * The spec lifecycle (§7). One approval gate for the whole spec — a person
 * flips `approved`; agents never approve their own input.
 *
 * draft → in_review → changes_requested → approved → building → delivered
 * (+ blocked for open business questions, reachable from anywhere pre-approval)
 */
export const SPEC_STATUSES = [
  'draft',
  'in_review',
  'changes_requested',
  'approved',
  'building',
  'delivered',
  'blocked',
] as const;

export type SpecStatus = (typeof SPEC_STATUSES)[number];

/** Statuses a coding agent (or `specd spec pull`) is allowed to read from. */
export const BUILDABLE_STATUSES: readonly SpecStatus[] = ['approved', 'building', 'delivered'];

/**
 * Legal transitions. Everything not listed here is refused by the API — the
 * gate is a state machine, not a convention (D11: a gate you can wire around
 * is no gate).
 */
const TRANSITIONS: Record<SpecStatus, readonly SpecStatus[]> = {
  draft: ['in_review', 'blocked'],
  in_review: ['changes_requested', 'approved', 'blocked'],
  changes_requested: ['in_review', 'blocked'],
  // Approval is terminal for review; the only way back is a new version.
  approved: ['building', 'delivered'],
  building: ['delivered', 'blocked'],
  delivered: [],
  blocked: ['draft', 'in_review'],
};

export function canTransition(from: SpecStatus, to: SpecStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function allowedTransitions(from: SpecStatus): readonly SpecStatus[] {
  return TRANSITIONS[from];
}

/** Only a human may set this status; the agent runner is never permitted to. */
export function isHumanOnlyStatus(status: SpecStatus): boolean {
  return status === 'approved';
}

/** Board columns are the lifecycle, deliberately shallow (D5). */
export const BOARD_COLUMNS = [
  { key: 'backlog', name: 'Backlog', status: null },
  { key: 'draft', name: 'Spec draft', status: 'draft' },
  { key: 'review', name: 'In review', status: 'in_review' },
  { key: 'approved', name: 'Approved', status: 'approved' },
  { key: 'building', name: 'Building', status: 'building' },
  { key: 'done', name: 'Done', status: 'delivered' },
] as const satisfies readonly { key: string; name: string; status: SpecStatus | null }[];

export type BoardColumnKey = (typeof BOARD_COLUMNS)[number]['key'];

/** Which column a ticket belongs in, given its current spec status. */
export function columnForStatus(status: SpecStatus | null | undefined): BoardColumnKey {
  if (!status) return 'backlog';
  switch (status) {
    case 'draft':
    case 'blocked':
      return 'draft';
    case 'in_review':
    case 'changes_requested':
      return 'review';
    case 'approved':
      return 'approved';
    case 'building':
      return 'building';
    case 'delivered':
      return 'done';
  }
}
