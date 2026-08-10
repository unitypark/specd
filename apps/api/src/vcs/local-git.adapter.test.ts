import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalGitAdapter } from './local-git.adapter.js';
import type { Config } from '../config.js';
import type { RepoTarget } from './vcs.types.js';

/**
 * The real adapter against a real git repository.
 *
 * Every suite that indexes uses a fake adapter, which is right — they are
 * testing the indexer, not git. The cost is that nothing exercised these
 * methods against git itself, and a listing bug lived through two releases
 * because of it: `git ls-files -- ''` is a hard error, and asking for the
 * whole tree passes exactly that empty prefix.
 */

let dir = '';
let adapter: LocalGitAdapter;
let target: RepoTarget;

const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });

describe('LocalGitAdapter against a real repository', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'specd-adapter-'));
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');

    mkdirSync(join(dir, 'knowledge'), { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'knowledge', 'a.md'), '# A\n');
    writeFileSync(join(dir, 'src', 'main.ts'), 'export const x = 1;\n');
    writeFileSync(join(dir, 'README.md'), '# Root\n');
    git('add', '-A');
    git('commit', '-qm', 'first');

    adapter = new LocalGitAdapter({ localRepoRoot: null } as Config);
    target = { name: 'test/repo', localPath: dir, defaultBranch: 'main' } as RepoTarget;
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('lists the whole tree for an empty prefix', async () => {
    // The regression. Indexing asks for everything so that docs and code come
    // from one listing, and git rejects an empty pathspec outright.
    await expect(adapter.listFiles(target, '')).resolves.toEqual(
      expect.arrayContaining(['README.md', 'knowledge/a.md', 'src/main.ts']),
    );
  });

  it('lists the whole tree with shas for an empty prefix', async () => {
    const files = await adapter.listFilesWithSha(target, '');
    expect(files.map((f) => f.path)).toEqual(
      expect.arrayContaining(['README.md', 'knowledge/a.md', 'src/main.ts']),
    );
    // A blob sha, not a path or a placeholder: it is what tells a changed file
    // from an unchanged one, so an empty or malformed value would silently
    // re-read the whole repository every run.
    for (const file of files) expect(file.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('still filters when given a prefix', async () => {
    expect(await adapter.listFiles(target, 'knowledge/')).toEqual(['knowledge/a.md']);
    const withSha = await adapter.listFilesWithSha(target, 'knowledge/');
    expect(withSha.map((f) => f.path)).toEqual(['knowledge/a.md']);
  });

  it('reports the same sha git does, and a new one after an edit', async () => {
    const before = (await adapter.listFilesWithSha(target, 'src/'))[0]!;
    const fromGit = git('rev-parse', 'HEAD:src/main.ts').trim();
    expect(before.sha).toBe(fromGit);

    writeFileSync(join(dir, 'src', 'main.ts'), 'export const x = 2;\n');
    git('add', '-A');
    git('commit', '-qm', 'second');

    const after = (await adapter.listFilesWithSha(target, 'src/'))[0]!;
    expect(after.sha).not.toBe(before.sha);
  });
});
