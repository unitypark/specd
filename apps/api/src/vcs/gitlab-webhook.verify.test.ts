import { describe, expect, it } from 'vitest';
import {
  classifyMergeRequest,
  classifyPush,
  verifyToken,
  type MergeRequestEvent,
} from './gitlab-webhook.verify.js';

const SECRET = 'it-was-a-dark-and-stormy-night';
const isSpecBranch = (branch: string) => branch.startsWith('spec/');

describe('verifyToken', () => {
  it('accepts the exact token GitLab was configured with', () => {
    expect(verifyToken(SECRET, SECRET)).toEqual({ ok: true });
  });

  it('rejects a token that does not match', () => {
    expect(verifyToken('someone-elses-guess', SECRET)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('fails closed when no secret is configured', () => {
    // The dangerous default. If an unset secret meant "skip the check", a
    // forgotten env var would leave an open, unauthenticated write endpoint —
    // anyone could POST "this MR merged" and move specs.
    expect(verifyToken(undefined, '')).toEqual({ ok: false, reason: 'no-secret' });
    expect(verifyToken(SECRET, '')).toEqual({ ok: false, reason: 'no-secret' });
  });

  it('rejects a missing token header', () => {
    expect(verifyToken(undefined, SECRET)).toEqual({ ok: false, reason: 'missing-token' });
    expect(verifyToken('', SECRET)).toEqual({ ok: false, reason: 'missing-token' });
  });

  it('is not confused by a value that shares a prefix', () => {
    expect(verifyToken(SECRET.slice(0, 10), SECRET)).toEqual({ ok: false, reason: 'mismatch' });
    expect(verifyToken(`${SECRET}-extra`, SECRET)).toEqual({ ok: false, reason: 'mismatch' });
  });
});

describe('classifyMergeRequest', () => {
  const repo = { setupBranch: 'specd/setup' };

  const merged = (branch: string): MergeRequestEvent => ({
    object_kind: 'merge_request',
    object_attributes: {
      iid: 42,
      action: 'merge',
      state: 'merged',
      source_branch: branch,
      target_branch: 'main',
    },
    user: { username: 'alice' },
  });

  it('treats a merged setup MR as adoption', () => {
    const intent = classifyMergeRequest(merged('specd/setup'), repo, isSpecBranch);
    expect(intent).toEqual({
      kind: 'setup-merged',
      branch: 'specd/setup',
      prNumber: 42,
      mergedBy: 'alice',
    });
  });

  it('treats a merged spec branch as delivery', () => {
    const intent = classifyMergeRequest(merged('spec/crm-142-export-csv'), repo, isSpecBranch);
    expect(intent.kind).toBe('spec-merged');
  });

  it('ignores an MR closed without merging', () => {
    // GitLab tells these apart with a dedicated action, unlike GitHub's
    // overloaded "closed" — no `merged` boolean needed to disambiguate.
    const event = merged('spec/crm-142-export-csv');
    event.object_attributes = { ...event.object_attributes!, action: 'close', state: 'closed' };
    const intent = classifyMergeRequest(event, repo, isSpecBranch);
    expect(intent).toMatchObject({ kind: 'ignore' });
    expect(intent.kind === 'ignore' && intent.why).toContain('closed without merging');
  });

  it('ignores open, update and approval events', () => {
    for (const action of ['open', 'update', 'approved', 'unapproved', 'reopen']) {
      const event = merged('spec/x-1-y');
      event.object_attributes = { ...event.object_attributes!, action, state: 'opened' };
      const intent = classifyMergeRequest(event, repo, isSpecBranch);
      expect(intent.kind, `${action} must not act`).toBe('ignore');
    }
  });

  it('ignores a merged branch that is not specd’s', () => {
    const intent = classifyMergeRequest(merged('feature/someone-elses-work'), repo, isSpecBranch);
    expect(intent).toMatchObject({ kind: 'ignore' });
  });

  it('does not mistake a setup branch for a spec branch when none is recorded', () => {
    const intent = classifyMergeRequest(merged('specd/setup'), { setupBranch: null }, isSpecBranch);
    expect(intent.kind).toBe('ignore');
  });

  it('survives a payload missing the pieces it reads', () => {
    expect(classifyMergeRequest({}, repo, isSpecBranch).kind).toBe('ignore');
    expect(
      classifyMergeRequest(
        { object_attributes: { iid: 1, action: 'merge', state: 'merged' } },
        repo,
        isSpecBranch,
      ).kind,
    ).toBe('ignore');
  });

  it('reports an unknown merger as null rather than inventing one', () => {
    const event = merged('spec/crm-1-x');
    event.user = undefined;
    const intent = classifyMergeRequest(event, repo, isSpecBranch);
    expect(intent).toMatchObject({ kind: 'spec-merged', mergedBy: null });
  });
});

describe('classifyPush reused against a GitLab-shaped payload', () => {
  // GitLab's Push Hook has no `head_commit` (a GitHub-only field) — proving
  // the reused classifier still works with only `commits[]` present is the
  // point of these, not re-testing logic already covered in
  // github-webhook.verify.test.ts.

  it('re-indexes when knowledge/ changes on the default branch', () => {
    const intent = classifyPush(
      { ref: 'refs/heads/main', commits: [{ added: [], modified: ['knowledge/architecture.md'], removed: [] }] },
      'main',
    );
    expect(intent).toMatchObject({ kind: 'reindex', paths: ['knowledge/architecture.md'] });
  });

  it('ignores a push that leaves knowledge/ alone', () => {
    const intent = classifyPush(
      { ref: 'refs/heads/main', commits: [{ added: ['src/app.ts'], modified: [], removed: [] }] },
      'main',
    );
    expect(intent.kind).toBe('ignore');
  });

  it('ignores a push to a non-default branch', () => {
    const intent = classifyPush(
      { ref: 'refs/heads/feature', commits: [{ added: ['knowledge/a.md'], modified: [], removed: [] }] },
      'main',
    );
    expect(intent.kind).toBe('ignore');
  });
});
