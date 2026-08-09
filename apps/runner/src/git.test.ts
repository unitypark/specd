import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canReachRemote, changedFiles, commitAll, git, isGitAvailable } from './git.js';

/**
 * Against a real `git`, not a mock. The whole reason this module exists is
 * that the runner talks to the actual binary with the actual machine's
 * credentials — a fake would test the fake.
 */

const available = await isGitAvailable();
let dir = '';

describe.skipIf(!available)('runner git', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'specd-git-test-'));
    await git(['init', '-b', 'main'], dir);
    await git(['config', 'user.name', 'test'], dir);
    await git(['config', 'user.email', 'test@example.test'], dir);
    await writeFile(join(dir, 'seed.txt'), 'seed\n', 'utf8');
    await git(['add', '-A'], dir);
    await git(['commit', '-m', 'seed'], dir);
  });

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('reports nothing changed in a clean tree', async () => {
    expect(await changedFiles(dir)).toEqual([]);
  });

  it('sees new, modified and nested files the agent wrote', async () => {
    await writeFile(join(dir, 'seed.txt'), 'seed\nmodified\n', 'utf8');
    await writeFile(join(dir, 'added.txt'), 'new\n', 'utf8');
    await mkdir(join(dir, 'knowledge', 'specs'), { recursive: true });
    await writeFile(join(dir, 'knowledge', 'specs', 'AC-1-x.md'), '# as built\n', 'utf8');

    const changed = await changedFiles(dir);
    expect(changed).toContain('seed.txt');
    expect(changed).toContain('added.txt');
    // The as-built spec lands in a directory that did not exist before, which
    // porcelain reports as an untracked *directory* unless asked otherwise.
    expect(changed.some((p) => p.startsWith('knowledge/'))).toBe(true);
  });

  it('commits everything and returns the sha', async () => {
    const sha = await commitAll(dir, 'AC-1 T1: do the thing');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await changedFiles(dir)).toEqual([]);

    const { stdout } = await git(['log', '-1', '--pretty=%s%n%an'], dir);
    expect(stdout).toContain('AC-1 T1: do the thing');
    // Commits are attributed to specd, the same way the in-process path does.
    expect(stdout).toContain('specd build');
  });

  it('returns null rather than an empty commit when a task changed nothing', async () => {
    expect(await commitAll(dir, 'nothing to see')).toBeNull();
  });

  it('reports a remote it cannot reach instead of hanging on a credential prompt', async () => {
    // A path that is not a repository: git fails fast rather than prompting,
    // which is what GIT_TERMINAL_PROMPT=0 buys us on a headless runner.
    const result = await canReachRemote(join(dir, 'no-such-remote.git'), dir);
    expect(result).not.toBe(true);
    expect(typeof result).toBe('string');
  });

  it('reaches a remote it can read', async () => {
    expect(await canReachRemote(dir, dir)).toBe(true);
  });
});
