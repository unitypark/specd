import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectHost, openLocalReview } from './local-review.js';

describe('detectHost', () => {
  it('recognizes github and gitlab over ssh and https alike', () => {
    expect(detectHost('git@github.com:owner/repo.git')).toEqual({
      kind: 'github',
      path: 'owner/repo',
    });
    expect(detectHost('https://github.com/owner/repo')).toEqual({
      kind: 'github',
      path: 'owner/repo',
    });
    expect(detectHost('git@gitlab.com:group/sub/repo.git')).toEqual({
      kind: 'gitlab',
      path: 'group/sub/repo',
    });
  });

  it('refuses to guess what software a self-managed host runs', () => {
    // Guessing wrong means running `gh` against someone's private git server.
    expect(detectHost('https://ghe.example.com/owner/repo.git')).toBeNull();
    expect(detectHost('git@git.internal:team/repo.git')).toBeNull();
    expect(detectHost('')).toBeNull();
  });
});

describe('openLocalReview', () => {
  let dir = '';
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' as const });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'specd-review-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t.dev');
    git('config', 'user.name', 'T');
    writeFileSync(join(dir, 'README.md'), '# x\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('does not push to a host it cannot open a review on', async () => {
    // The check order is the safety property: an unrecognized remote is
    // answered before anything is published to it.
    const review = await openLocalReview({
      git: simpleGit({ baseDir: dir }),
      cwd: dir,
      remoteUrl: 'git@git.internal:team/repo.git',
      branch: 'specd/setup',
      base: 'main',
      title: 'setup',
      body: 'body',
    });

    expect(review.url).toBeNull();
    expect(review.note).toContain('not a host specd can open a review on');
    // Nothing was written to the repository's config or refs on the way out.
    expect(git('remote').trim()).toBe('');
  });
});
