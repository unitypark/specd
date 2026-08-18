import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  describeForPushOption,
  run,
  detectHost,
  instanceUrlFromRemote,
  openLocalReview,
  projectPathFromRemote,
  resolveGitLabRoot,
} from './local-review.js';

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

describe('instanceUrlFromRemote', () => {
  it('reads the host a clone already names, in either remote syntax', () => {
    expect(instanceUrlFromRemote('git@gitlab.example.com:acme/services/api.git')).toBe(
      'https://gitlab.example.com',
    );
    expect(instanceUrlFromRemote('https://gitlab.example.com/acme/services/api.git')).toBe(
      'https://gitlab.example.com',
    );
  });

  it('drops an ssh port and keeps a web one', () => {
    // `:2222` on an ssh remote is the SSH port. Carrying it onto an API URL
    // would be confidently wrong, which is worse than asking.
    expect(instanceUrlFromRemote('ssh://git@gitlab.example.com:2222/acme/api.git')).toBe(
      'https://gitlab.example.com',
    );
    expect(instanceUrlFromRemote('https://gitlab.example.com:8443/acme/api.git')).toBe(
      'https://gitlab.example.com:8443',
    );
  });

  it('has no answer for a remote with no host', () => {
    expect(instanceUrlFromRemote('/srv/git/bare.git')).toBeNull();
    expect(instanceUrlFromRemote('')).toBeNull();
  });
});

describe('a subpath-hosted instance', () => {
  const instance = 'https://intranet.example.com/gitlab';

  it('strips the instance prefix from both remote syntaxes', () => {
    // The regression: the prefix was compared against `URL.pathname`, which
    // carries a leading slash, while the scp branch produced one without —
    // so an ssh remote silently kept the instance path inside the project
    // path, and ssh is what a corporate clone actually uses.
    expect(projectPathFromRemote('https://intranet.example.com/gitlab/group/project.git', instance)).toBe(
      'group/project',
    );
    expect(projectPathFromRemote('git@intranet.example.com:gitlab/group/project.git', instance)).toBe(
      'group/project',
    );
  });

  it('leaves a path alone when it merely starts with similar letters', () => {
    // `gitlab-runner/...` is not inside `/gitlab`, and a prefix match without
    // the separator would eat four characters off a real group name.
    expect(
      projectPathFromRemote('git@intranet.example.com:gitlab-runner/project.git', instance),
    ).toBe('gitlab-runner/project');
  });
});

describe('resolveGitLabRoot', () => {
  const remote = 'git@gitlab.example.com:ET130/services/api.git';

  it('keeps the root when GitLab answers there — the leading segment is a group', () => {
    const probe = async (url: string) => (url === 'https://gitlab.example.com/api/v4/version' ? 401 : 404);
    return expect(resolveGitLabRoot('https://gitlab.example.com', remote, probe)).resolves.toBe(
      'https://gitlab.example.com',
    );
  });

  it('walks one segment in when GitLab is served from a subpath', async () => {
    const probe = async (url: string) =>
      url === 'https://gitlab.example.com/ET130/api/v4/version' ? 200 : 404;
    await expect(resolveGitLabRoot('https://gitlab.example.com', remote, probe)).resolves.toBe(
      'https://gitlab.example.com/ET130',
    );
  });

  it('prefers the root, and returns it unchanged when neither answers', async () => {
    // A wrong instance URL is then reported by describeApiBase404, which says
    // which half to drop — better than silently addressing a group.
    await expect(resolveGitLabRoot('https://gitlab.example.com', remote, async () => 404)).resolves.toBe(
      'https://gitlab.example.com',
    );
  });
});

describe('describeForPushOption', () => {
  it('passes a short body through untouched', () => {
    expect(describeForPushOption('short')).toBe('short');
  });

  it('trims a long one and says that it did', () => {
    const out = describeForPushOption('x'.repeat(4000));
    expect(out.length).toBeLessThan(1700);
    expect(out).toMatch(/truncated/);
  });
});

describe('the push-option route against a remote that does not take them', () => {
  // A local bare repo refuses push options exactly as GitLab before 11.10
  // does: it rejects the whole push and sends nothing. The branch still has to
  // arrive, so the retry is what keeps a working setup working.
  let dir = '';
  let remote = '';
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' as const });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'specd-pushopt-'));
    remote = mkdtempSync(join(tmpdir(), 'specd-pushopt-remote-'));
    execFileSync('git', ['init', '-q', '--bare', remote]);
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t.dev');
    git('config', 'user.name', 'T');
    git('remote', 'add', 'origin', remote);
    writeFileSync(join(dir, 'README.md'), '# x\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
    git('checkout', '-q', '-b', 'spec/E-9-thing');
    writeFileSync(join(dir, 'f.txt'), 'work\n');
    git('add', '-A');
    git('commit', '-qm', 'work');
    git('checkout', '-q', 'main');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  });

  it('still publishes the branch, and says the merge request did not come from the push', async () => {
    const result = await openLocalReview({
      git: simpleGit({ baseDir: dir }),
      cwd: dir,
      remoteUrl: 'git@gitlab.example.com:acme/services/api.git',
      branch: 'spec/E-9-thing',
      base: 'main',
      title: '[E-9] - Thing',
      body: 'body',
      credential: { provider: 'gitlab', token: null, instanceUrl: null },
    });

    expect(
      execFileSync('git', ['branch', '--list', 'spec/E-9-thing'], { cwd: remote, encoding: 'utf8' }),
    ).toContain('spec/E-9-thing');
    expect(result.url).toBeNull();
    expect(result.note).toMatch(/did not report a merge request from the push/);
  });
});

describe('a child that exits before it reads stdin', () => {
  /**
   * The CI failure this pins. `openLocalReview` shells out to `gh`, `glab` and
   * `git`, and in the common failure cases — no such binary, a rejected push —
   * the child is gone before the prompt is written. Node reports that write as
   * an `error` on the stdin stream, and unhandled it is an *uncaught
   * exception*: every test in the run passed and the run still failed.
   *
   * Made deterministic by writing far more than any pipe buffer to a command
   * that exits at once, so the write always outlives the process rather than
   * usually winning the race.
   */
  const withoutUncaught = async (fn: () => Promise<unknown>) => {
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.on('uncaughtException', onUncaught);
    try {
      await fn();
      await new Promise((r) => setTimeout(r, 50)); // let an async EPIPE surface
      return uncaught;
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  };

  it('answers instead of raising, when the pipe is already closed', async () => {
    let result: { code: number | null } | undefined;
    const uncaught = await withoutUncaught(async () => {
      result = await run('git', ['--version'], { cwd: process.cwd(), stdin: 'x'.repeat(8_000_000) });
    });

    expect(uncaught).toEqual([]);
    // The call still reports the child's outcome — a pipe nobody read is not
    // a failure of the command.
    expect(result?.code).toBe(0);
  });

  it('does not raise when the binary does not exist at all', async () => {
    // The CI shape: no `gh` on the runner, so the spawn fails and there is no
    // process to receive the write.
    const uncaught = await withoutUncaught(async () => {
      const out = await run('specd-no-such-binary', ['--version'], {
        cwd: process.cwd(),
        stdin: 'x'.repeat(8_000_000),
      });
      expect(out.code).toBeNull();
    });
    expect(uncaught).toEqual([]);
  });
});
