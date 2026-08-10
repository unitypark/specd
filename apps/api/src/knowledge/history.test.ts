import { describe, expect, it } from 'vitest';
import {
  MAX_FILES_PER_COMMIT,
  codeArea,
  couplingFrom,
  parseCommitLog,
  type HistoryCommit,
} from './history.js';

const day = (n: number) => new Date(Date.UTC(2026, 0, n));
const commit = (n: number, files: string[]): HistoryCommit => ({
  sha: `c${n}`,
  at: day(n),
  files,
});

describe('codeArea', () => {
  it('groups a file to a readable area rather than itself', () => {
    // Nine files in one directory is one relationship, not nine.
    expect(codeArea('apps/api/src/runners/runner-jobs.service.ts')).toBe('apps/api/src/');
    expect(codeArea('src/main.ts')).toBe('src/');
  });

  it('leaves a root file alone', () => {
    expect(codeArea('package.json')).toBe('package.json');
  });
});

describe('couplingFrom', () => {
  it('couples a doc to the code it changes with', () => {
    const edges = couplingFrom([
      commit(1, ['knowledge/runbooks/deploy.md', 'apps/api/src/deploy/run.ts']),
      commit(2, ['knowledge/runbooks/deploy.md', 'apps/api/src/deploy/env.ts']),
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      docPath: 'knowledge/runbooks/deploy.md',
      codePath: 'apps/api/src/',
      commitsTogether: 2,
    });
  });

  it('ignores a commit that touches everything', () => {
    // A formatting sweep couples every doc to every file, and precision never
    // recovers from being told the README changes with all of them.
    const sweep = commit(3, [
      'knowledge/architecture.md',
      ...Array.from({ length: MAX_FILES_PER_COMMIT }, (_, i) => `apps/web/src/f${i}.ts`),
    ]);
    expect(couplingFrom([sweep])).toEqual([]);
  });

  it('ignores lockfiles and generated output', () => {
    const edges = couplingFrom([
      commit(1, ['knowledge/architecture.md', 'pnpm-lock.yaml', 'dist/bundle.js', 'apps/api/src/a.ts']),
    ]);
    expect(edges.map((e) => e.codePath)).toEqual(['apps/api/src/']);
  });

  it('ignores a commit with no doc in it, while still counting the code touch', () => {
    const edges = couplingFrom([
      commit(1, ['knowledge/architecture.md', 'apps/api/src/a.ts']),
      commit(2, ['apps/api/src/b.ts']),
      commit(3, ['apps/api/src/c.ts']),
    ]);
    expect(edges).toHaveLength(1);
    // Two commits moved the coupled area after the doc last moved with it.
    expect(edges[0]?.commitsSince).toBe(2);
  });

  it('measures drift from the last time they moved together, not from the doc alone', () => {
    // A doc can be edited without being reconciled against the code. What
    // says "these have diverged" is the code moving after they last moved as
    // one — a doc touched in between does not close that gap.
    const edges = couplingFrom([
      commit(1, ['knowledge/architecture.md', 'apps/api/src/a.ts']),
      commit(2, ['apps/api/src/b.ts']),
      commit(3, ['knowledge/architecture.md']), // typo fix, no code
      commit(4, ['apps/api/src/c.ts']),
    ]);
    expect(edges[0]?.commitsSince).toBe(2);
  });

  it('reports nothing when a doc never moved with code', () => {
    expect(couplingFrom([commit(1, ['knowledge/glossary.md'])])).toEqual([]);
  });

  it('orders the strongest coupling first', () => {
    const edges = couplingFrom([
      commit(1, ['knowledge/architecture.md', 'apps/api/src/a.ts']),
      commit(2, ['knowledge/architecture.md', 'apps/api/src/a.ts']),
      commit(3, ['knowledge/architecture.md', 'apps/web/src/b.ts']),
    ]);
    expect(edges.map((e) => e.codePath)).toEqual(['apps/api/src/', 'apps/web/src/']);
  });

  it('is not confused by commits arriving newest-first', () => {
    // `git log` hands them back in reverse order; the drift count depends on
    // knowing which touch came last.
    const ordered = couplingFrom([
      commit(1, ['knowledge/a.md', 'src/x.ts']),
      commit(2, ['src/x.ts']),
    ]);
    const reversed = couplingFrom([
      commit(2, ['src/x.ts']),
      commit(1, ['knowledge/a.md', 'src/x.ts']),
    ]);
    expect(reversed).toEqual(ordered);
  });
});

describe('parseCommitLog', () => {
  const NUL = String.fromCharCode(0);
  const log = [
    `${NUL}abc123 2026-08-10T11:32:37.000Z`,
    'apps/api/src/a.ts',
    'knowledge/architecture.md',
    '',
    `${NUL}def456 2026-08-09T10:00:00.000Z`,
    'apps/web/src/b.tsx',
    '',
  ].join('\n');

  it('reads records, shas, dates and files', () => {
    const commits = parseCommitLog(log);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatchObject({
      sha: 'abc123',
      files: ['apps/api/src/a.ts', 'knowledge/architecture.md'],
    });
    expect(commits[0]?.at.toISOString()).toBe('2026-08-10T11:32:37.000Z');
    expect(commits[1]?.files).toEqual(['apps/web/src/b.tsx']);
  });

  it('keeps a commit that touched no files', () => {
    // An empty commit is still a commit; dropping it would silently shift the
    // window's shape.
    expect(parseCommitLog(`${NUL}abc123 2026-08-10T11:32:37.000Z\n`)).toEqual([
      { sha: 'abc123', at: new Date('2026-08-10T11:32:37.000Z'), files: [] },
    ]);
  });

  it('returns nothing for empty or malformed output', () => {
    expect(parseCommitLog('')).toEqual([]);
    expect(parseCommitLog(`${NUL}not-a-record\n`)).toEqual([]);
    expect(parseCommitLog(`${NUL}abc123 not-a-date\n`)).toEqual([]);
  });
});
