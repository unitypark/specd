import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { detectHost, openLocalReview, projectPathFromRemote } from './local-review.js';

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
    expect(review.note).toContain('will not guess what software a self-managed host runs');
    // Nothing was written to the repository's config or refs on the way out.
    expect(git('remote').trim()).toBe('');
  });
});

describe('projectPathFromRemote', () => {
  it('reads the path out of every spelling git uses', () => {
    const want = 'acme/services/aurora-api';
    expect(projectPathFromRemote('git@gitlab.example.com:acme/services/aurora-api.git')).toBe(want);
    expect(projectPathFromRemote('https://gitlab.example.com/acme/services/aurora-api.git')).toBe(want);
    expect(projectPathFromRemote('https://gitlab.example.com/acme/services/aurora-api')).toBe(want);
    expect(projectPathFromRemote('ssh://git@gitlab.example.com:2222/acme/services/aurora-api.git')).toBe(want);
  });

  it('removes the instance subpath, which is not part of the project path', () => {
    // GitLab at https://host/gitlab serves the project `group/project` — the
    // subpath belongs to the instance, and passing it through would address a
    // project that does not exist.
    expect(
      projectPathFromRemote('https://intranet.example.com/gitlab/group/project.git', 'https://intranet.example.com/gitlab'),
    ).toBe('group/project');
  });

  it('answers null when there is no namespace to be had', () => {
    // Every GitLab and GitHub project path has at least one slash; something
    // without one is not one, and inventing a namespace would be worse.
    expect(projectPathFromRemote('git@host:project.git')).toBeNull();
    expect(projectPathFromRemote('')).toBeNull();
  });
});

describe('a configured review credential', () => {
  let dir = '';
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' as const });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'specd-cred-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t.dev');
    git('config', 'user.name', 'T');
    writeFileSync(join(dir, 'README.md'), '# x\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  afterEach(() => vi.unstubAllGlobals());

  const review = (over: Partial<Parameters<typeof openLocalReview>[0]> = {}) =>
    openLocalReview({
      git: simpleGit({ baseDir: dir }),
      cwd: dir,
      remoteUrl: 'git@gitlab.example.com:acme/services/aurora-api.git',
      branch: 'spec/E-101-add-csv-export',
      base: 'main',
      title: '[E-101] - Add CSV export',
      body: 'body',
      credential: { provider: 'gitlab', token: 'glpat-x', instanceUrl: 'https://gitlab.example.com' },
      ...over,
    });

  it('reaches a self-managed host the CLI path refuses to guess at', async () => {
    // The whole point: `detectHost` answers null for this remote, so without a
    // credential there is no review. With one, the host is not being guessed —
    // it was named.
    expect(detectHost('git@gitlab.example.com:acme/services/aurora-api.git')).toBeNull();

    let opened: { url: string } | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        opened = { url };
        return {
          ok: true,
          status: 201,
          text: async () =>
            JSON.stringify({ web_url: 'https://gitlab.example.com/acme/services/aurora-api/-/merge_requests/7', iid: 7 }),
          json: async () => ({ web_url: 'https://gitlab.example.com/acme/services/aurora-api/-/merge_requests/7', iid: 7 }),
        };
      }),
    );

    // The push has nowhere to go in a bare fixture, so the failure is the
    // push, not the credential — which is itself the ordering guarantee worth
    // pinning: nothing is opened for a branch that never reached the remote.
    const result = await review();
    expect(result.url).toBeNull();
    expect(result.note).toMatch(/pushing to origin failed/);
    expect(opened).toBeNull();
  });

  it('pushes the branch, then opens the merge request against the named instance', async () => {
    // A real remote, so the push is real; only the GitLab API is stubbed.
    const remote = mkdtempSync(join(tmpdir(), 'specd-remote-'));
    execFileSync('git', ['init', '-q', '--bare', remote]);
    git('remote', 'add', 'origin', remote);
    git('checkout', '-q', '-b', 'spec/E-101-add-csv-export');
    writeFileSync(join(dir, 'feature.txt'), 'work\n');
    git('add', '-A');
    git('commit', '-qm', 'work');
    git('checkout', '-q', 'main');

    const seen: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        seen.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
        return {
          ok: true,
          status: 201,
          text: async () =>
            JSON.stringify({
              web_url: 'https://gitlab.example.com/acme/services/aurora-api/-/merge_requests/7',
              iid: 7,
            }),
          json: async () => ({
            web_url: 'https://gitlab.example.com/acme/services/aurora-api/-/merge_requests/7',
            iid: 7,
          }),
        };
      }),
    );

    try {
      // `origin` is the bare repo so the push is genuinely exercised, while
      // `remoteUrl` stays the GitLab URL that names the project. In production
      // both come from the same `git remote get-url origin`; splitting them
      // here is what lets the push be real without a GitLab to push to.
      const result = await review();

      // The branch really landed on the remote — a review for a branch that
      // never got there would be a broken link.
      expect(
        execFileSync('git', ['branch', '--list', 'spec/E-101-add-csv-export'], {
          cwd: remote,
          encoding: 'utf8',
        }),
      ).toContain('spec/E-101-add-csv-export');

      expect(result.url).toBe(
        'https://gitlab.example.com/acme/services/aurora-api/-/merge_requests/7',
      );
      expect(result.note).toMatch(/opened a merge request with this project's token/);

      // Addressed to the instance that was named, for the project the remote
      // named, with the title the build station chose.
      expect(seen[0]?.url).toBe(
        'https://gitlab.example.com/api/v4/projects/acme%2Fservices%2Faurora-api/merge_requests',
      );
      expect(seen[0]?.body).toMatchObject({
        source_branch: 'spec/E-101-add-csv-export',
        target_branch: 'main',
        title: '[E-101] - Add CSV export',
      });
    } finally {
      rmSync(remote, { recursive: true, force: true });
      git('remote', 'remove', 'origin');
    }
  });
});
