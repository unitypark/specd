import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  commitsFromPush,
  classifyPullRequest,
  classifyPush,
  pushedPaths,
  signBody,
  verifySignature,
  type PullRequestEvent,
  type PushEvent,
} from './github-webhook.verify.js';

const SECRET = 'it-was-a-dark-and-stormy-night';
const isSpecBranch = (branch: string) => branch.startsWith('spec/');

describe('verifySignature', () => {
  const body = Buffer.from(JSON.stringify({ action: 'closed', number: 7 }));

  it('accepts a signature GitHub would have produced', () => {
    expect(verifySignature(body, signBody(body, SECRET), SECRET)).toEqual({ ok: true });
  });

  it('accepts an uppercase hex digest', () => {
    // GitHub sends lowercase, but a proxy or replay tool may not, and rejecting
    // a valid signature over letter case would be a maddening bug to chase.
    const upper = signBody(body, SECRET).toUpperCase().replace('SHA256', 'sha256');
    expect(verifySignature(body, upper, SECRET)).toEqual({ ok: true });
  });

  it('rejects a body that changed by a single byte', () => {
    const signature = signBody(body, SECRET);
    const tampered = Buffer.from(JSON.stringify({ action: 'closed', number: 8 }));
    expect(verifySignature(tampered, signature, SECRET)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects a signature made with a different secret', () => {
    expect(verifySignature(body, signBody(body, 'wrong-secret'), SECRET)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('fails closed when no secret is configured', () => {
    // The dangerous default. If an unset secret meant "skip the check", a
    // forgotten env var would leave an open, unauthenticated write endpoint —
    // anyone could POST "this PR merged" and move specs.
    const unsigned = verifySignature(body, undefined, '');
    const signed = verifySignature(body, signBody(body, SECRET), '');
    expect(unsigned).toEqual({ ok: false, reason: 'no-secret' });
    expect(signed).toEqual({ ok: false, reason: 'no-secret' });
  });

  it('rejects a missing or malformed signature header', () => {
    expect(verifySignature(body, undefined, SECRET)).toEqual({
      ok: false,
      reason: 'missing-signature',
    });
    for (const header of ['', 'sha1=abcdef', 'sha256=', 'sha256=not-hex', 'garbage']) {
      const result = verifySignature(body, header, SECRET);
      expect(result.ok, `header ${JSON.stringify(header)} must not verify`).toBe(false);
    }
  });

  it('rejects an empty body even when the signature matches it', () => {
    // An empty body is signable, but there is no event in it. Accepting one
    // would mean handling `{}` as if GitHub had said something.
    const empty = Buffer.alloc(0);
    expect(verifySignature(empty, signBody(empty, SECRET), SECRET)).toEqual({
      ok: false,
      reason: 'empty-body',
    });
    expect(verifySignature(undefined, signBody('', SECRET), SECRET)).toEqual({
      ok: false,
      reason: 'empty-body',
    });
  });

  it('is not confused by a truncated digest that shares a prefix', () => {
    const full = createHmac('sha256', SECRET).update(body).digest('hex');
    expect(verifySignature(body, `sha256=${full.slice(0, 32)}`, SECRET)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('verifies bodies with unicode and unusual whitespace byte-for-byte', () => {
    // The signature covers bytes, not a re-encoding. Anything that reserialises
    // the JSON on the way in breaks this test, which is the point.
    const raw = Buffer.from('{"title":"café ☕","body":"line\\n\\ttabbed"}', 'utf8');
    expect(verifySignature(raw, signBody(raw, SECRET), SECRET)).toEqual({ ok: true });
  });

  it('handles a large payload', () => {
    const raw = randomBytes(512_000);
    expect(verifySignature(raw, signBody(raw, SECRET), SECRET)).toEqual({ ok: true });
  });
});

describe('classifyPullRequest', () => {
  const repo = { setupBranch: 'specd/setup' };

  const merged = (branch: string): PullRequestEvent => ({
    action: 'closed',
    pull_request: {
      number: 42,
      merged: true,
      head: { ref: branch },
      merged_by: { login: 'alice' },
    },
  });

  it('treats a merged setup PR as adoption', () => {
    const intent = classifyPullRequest(merged('specd/setup'), repo, isSpecBranch);
    expect(intent).toEqual({
      kind: 'setup-merged',
      branch: 'specd/setup',
      prNumber: 42,
      mergedBy: 'alice',
    });
  });

  it('treats a merged spec branch as delivery', () => {
    const intent = classifyPullRequest(merged('spec/crm-142-export-csv'), repo, isSpecBranch);
    expect(intent.kind).toBe('spec-merged');
  });

  it('ignores a PR closed without merging', () => {
    // Closing a spec PR is a rejection. Marking the spec delivered because the
    // PR "finished" would record the opposite of what happened.
    const event = merged('spec/crm-142-export-csv');
    event.pull_request!.merged = false;
    const intent = classifyPullRequest(event, repo, isSpecBranch);
    expect(intent).toMatchObject({ kind: 'ignore' });
    expect(intent.kind === 'ignore' && intent.why).toContain('without merging');
  });

  it('ignores opened, synchronize and review events', () => {
    for (const action of ['opened', 'synchronize', 'edited', 'review_requested', 'reopened']) {
      const intent = classifyPullRequest({ ...merged('spec/x-1-y'), action }, repo, isSpecBranch);
      expect(intent.kind, `${action} must not act`).toBe('ignore');
    }
  });

  it('ignores a merged branch that is not specd’s', () => {
    const intent = classifyPullRequest(merged('feature/someone-elses-work'), repo, isSpecBranch);
    expect(intent).toMatchObject({ kind: 'ignore' });
  });

  it('does not mistake a setup branch for a spec branch when none is recorded', () => {
    const intent = classifyPullRequest(merged('specd/setup'), { setupBranch: null }, isSpecBranch);
    expect(intent.kind).toBe('ignore');
  });

  it('survives a payload missing the pieces it reads', () => {
    expect(classifyPullRequest({ action: 'closed' }, repo, isSpecBranch).kind).toBe('ignore');
    expect(
      classifyPullRequest(
        { action: 'closed', pull_request: { number: 1, merged: true } },
        repo,
        isSpecBranch,
      ).kind,
    ).toBe('ignore');
  });

  it('reports an unknown merger as null rather than inventing one', () => {
    const event = merged('spec/crm-1-x');
    event.pull_request!.merged_by = null;
    const intent = classifyPullRequest(event, repo, isSpecBranch);
    expect(intent).toMatchObject({ kind: 'spec-merged', mergedBy: null });
  });
});

describe('classifyPush', () => {
  const push = (ref: string, paths: string[]): PushEvent => ({
    ref,
    commits: [{ added: [], modified: paths, removed: [] }],
  });

  it('re-indexes when knowledge/ changes on the default branch', () => {
    const intent = classifyPush(push('refs/heads/main', ['knowledge/architecture.md']), 'main');
    expect(intent).toMatchObject({ kind: 'reindex', paths: ['knowledge/architecture.md'] });
  });

  it('ignores a push to any other branch', () => {
    // The index reflects what is on the default branch. A feature branch has
    // changed nothing anyone has agreed to yet.
    expect(classifyPush(push('refs/heads/wip', ['knowledge/a.md']), 'main').kind).toBe('ignore');
    expect(classifyPush(push('refs/tags/v1.0.0', ['knowledge/a.md']), 'main').kind).toBe('ignore');
  });

  it('ignores a push that leaves knowledge/ alone', () => {
    expect(classifyPush(push('refs/heads/main', ['src/app.ts', 'README.md']), 'main').kind).toBe(
      'ignore',
    );
  });

  it('respects a default branch that is not main', () => {
    expect(classifyPush(push('refs/heads/trunk', ['knowledge/a.md']), 'trunk').kind).toBe('reindex');
    expect(classifyPush(push('refs/heads/main', ['knowledge/a.md']), 'trunk').kind).toBe('ignore');
  });

  it('notices a deleted knowledge file', () => {
    // A removal changes the index as surely as an edit does — the doc has to go.
    const event: PushEvent = {
      ref: 'refs/heads/main',
      commits: [{ removed: ['knowledge/decisions/adr-003.md'] }],
    };
    expect(classifyPush(event, 'main').kind).toBe('reindex');
  });

  it('does not match a path that merely contains knowledge/', () => {
    const event = push('refs/heads/main', ['docs/knowledge/notes.md', 'src/knowledge.ts']);
    expect(classifyPush(event, 'main').kind).toBe('ignore');
  });

  it('collects paths across every commit in the push', () => {
    const event: PushEvent = {
      ref: 'refs/heads/main',
      commits: [
        { added: ['knowledge/a.md'] },
        { modified: ['knowledge/b.md'], removed: ['src/x.ts'] },
        { added: ['knowledge/a.md'] },
      ],
      head_commit: { modified: ['knowledge/c.md'] },
    };
    const intent = classifyPush(event, 'main');
    expect(intent.kind).toBe('reindex');
    expect(intent.kind === 'reindex' && intent.paths.sort()).toEqual([
      'knowledge/a.md',
      'knowledge/b.md',
      'knowledge/c.md',
    ]);
  });

  it('deduplicates paths touched by more than one commit', () => {
    const event: PushEvent = {
      ref: 'refs/heads/main',
      commits: [{ modified: ['knowledge/a.md'] }, { modified: ['knowledge/a.md'] }],
    };
    expect(pushedPaths(event)).toEqual(['knowledge/a.md']);
  });

  it('survives a push payload with no commits at all', () => {
    expect(classifyPush({ ref: 'refs/heads/main' }, 'main').kind).toBe('ignore');
    expect(classifyPush({}, 'main').kind).toBe('ignore');
  });
});

/**
 * The history ledger's input (0013). A repo specd cannot clone still pushes,
 * and a push already carries what history mining needs.
 */
describe('commitsFromPush', () => {
  const push = (over: Record<string, unknown> = {}) => ({
    ref: 'refs/heads/main',
    commits: [
      {
        id: 'sha1',
        timestamp: '2026-08-10T10:00:00Z',
        added: ['apps/api/src/new.ts'],
        modified: ['knowledge/architecture.md'],
        removed: ['apps/api/src/old.ts'],
      },
    ],
    ...over,
  });

  it('reads sha, time and every touched path', () => {
    expect(commitsFromPush(push(), 'main')).toEqual([
      {
        sha: 'sha1',
        at: new Date('2026-08-10T10:00:00Z'),
        files: ['apps/api/src/new.ts', 'knowledge/architecture.md', 'apps/api/src/old.ts'],
      },
    ]);
  });

  it('records a push that touched no knowledge doc', () => {
    // The one classifyPush ignores, and precisely what drift is made of: code
    // moving while the docs stand still.
    const commits = commitsFromPush(
      push({ commits: [{ id: 's', timestamp: '2026-08-10T10:00:00Z', modified: ['apps/api/src/a.ts'] }] }),
      'main',
    );
    expect(commits).toHaveLength(1);
    expect(commits[0]?.files).toEqual(['apps/api/src/a.ts']);
  });

  it('ignores a push to any branch but the default', () => {
    // Coupling has to describe what landed, not work that may never merge.
    expect(commitsFromPush(push({ ref: 'refs/heads/feature/x' }), 'main')).toEqual([]);
  });

  it('does not record the head commit twice', () => {
    const event = push();
    const withHead = { ...event, head_commit: event.commits[0] };
    expect(commitsFromPush(withHead, 'main')).toHaveLength(1);
  });

  it('skips a commit with no id or no usable timestamp', () => {
    expect(
      commitsFromPush(
        push({
          commits: [
            { timestamp: '2026-08-10T10:00:00Z', modified: ['a.ts'] },
            { id: 'x', timestamp: 'not-a-date', modified: ['b.ts'] },
            { id: 'y', modified: ['c.ts'] },
          ],
        }),
        'main',
      ),
    ).toEqual([]);
  });
});
