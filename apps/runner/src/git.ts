import { spawn } from 'node:child_process';

/**
 * Just enough git for a build, spoken to the `git` binary directly.
 *
 * The API uses `simple-git`; this does not, deliberately. The daemon's whole
 * dependency list is `@specd/shared`, and every command below is one or two
 * arguments — a library here would buy nothing but a supply-chain entry on a
 * machine that belongs to the user, not to us.
 *
 * Nothing in this file takes a credential, and that is the point
 * (`knowledge/decisions/0009-...`): every remote operation runs as whoever
 * owns this machine, using the git configuration already on it. If a clone or
 * push is going to fail for auth reasons, it fails as that user's git would.
 */

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export async function git(
  args: string[],
  cwd: string,
  timeoutMs = 300_000,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // A build is not a place to answer a credential prompt. Without this,
        // a machine whose git access has lapsed hangs forever on a hidden
        // password prompt instead of failing with something a user can read.
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: 'echo',
      },
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
      resolve({ stdout, stderr: `${stderr}\n[git timed out after ${timeoutMs}ms]`, code: null });
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) resolve({ stdout, stderr: `${stderr}\n${err.message}`, code: null });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!settled) resolve({ stdout, stderr, code });
    });
  });
}

/** Run a git command, or throw with git's own explanation of why not. */
export async function gitOrThrow(
  args: string[],
  cwd: string,
  what: string,
  timeoutMs?: number,
): Promise<string> {
  const { stdout, stderr, code } = await git(args, cwd, timeoutMs);
  if (code !== 0) {
    throw new GitError(`${what}: ${(stderr || stdout).trim().split('\n').slice(-3).join(' ').slice(0, 400)}`, stderr);
  }
  return stdout;
}

export async function isGitAvailable(): Promise<boolean> {
  const { code } = await git(['--version'], process.cwd(), 15_000);
  return code === 0;
}

/**
 * Can this machine push to that remote, as itself?
 *
 * Asked before the first model call rather than discovered at the end. A
 * build that is going to fail on credentials should cost seconds, not a full
 * run's worth of tokens and minutes — `git ls-remote` is the cheapest question
 * that needs the same access the eventual push will.
 */
export async function canReachRemote(cloneUrl: string, cwd: string): Promise<true | string> {
  const { stderr, code } = await git(['ls-remote', '--heads', cloneUrl], cwd, 60_000);
  if (code === 0) return true;
  return stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400) || 'git could not reach the remote';
}

export async function shallowClone(
  cloneUrl: string,
  baseBranch: string,
  dir: string,
  parentDir: string,
): Promise<void> {
  await gitOrThrow(
    ['clone', '--depth', '1', '--branch', baseBranch, '--no-tags', cloneUrl, dir],
    parentDir,
    `Could not clone ${cloneUrl} at "${baseBranch}"`,
    600_000,
  );
}

export async function startBranch(dir: string, branch: string): Promise<void> {
  // Identify the commits as specd's, the same way the in-process path does.
  await gitOrThrow(['config', 'user.name', 'specd build'], dir, 'Could not configure git');
  await gitOrThrow(['config', 'user.email', 'bot@specd.dev'], dir, 'Could not configure git');
  await gitOrThrow(['checkout', '-b', branch], dir, `Could not create branch ${branch}`);
}

/** Paths the agent changed, relative to the workspace. */
export async function changedFiles(dir: string): Promise<string[]> {
  const stdout = await gitOrThrow(['status', '--porcelain'], dir, 'Could not read git status');
  return stdout
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    // A rename prints "old -> new"; the new path is the one that exists.
    .map((path) => (path.includes(' -> ') ? path.slice(path.indexOf(' -> ') + 4) : path))
    .filter((path, i, all) => all.indexOf(path) === i);
}

/** Stage and commit everything. Returns the sha, or null when there was nothing to commit. */
export async function commitAll(dir: string, message: string): Promise<string | null> {
  await gitOrThrow(['add', '-A'], dir, 'Could not stage changes');

  const staged = await gitOrThrow(['diff', '--cached', '--name-only'], dir, 'Could not read the index');
  if (!staged.trim()) return null;

  await gitOrThrow(
    ['commit', '-m', message, '--author', 'specd build <bot@specd.dev>'],
    dir,
    'Could not commit',
  );
  return (await gitOrThrow(['rev-parse', 'HEAD'], dir, 'Could not read HEAD')).trim();
}

export async function commitCount(dir: string, baseBranch: string): Promise<number> {
  const { stdout, code } = await git(['rev-list', '--count', `origin/${baseBranch}..HEAD`], dir);
  if (code !== 0) return 0;
  return Number(stdout.trim()) || 0;
}

/**
 * Publish the branch. Force, because a re-run of the same spec replaces its
 * branch rather than failing on a non-fast-forward — the branch belongs to
 * the spec, not to an attempt at it.
 */
export async function pushBranch(dir: string, cloneUrl: string, branch: string): Promise<void> {
  await gitOrThrow(
    ['push', '--force', cloneUrl, `HEAD:refs/heads/${branch}`],
    dir,
    `Could not push ${branch}`,
    600_000,
  );
}
