import { spawn } from 'node:child_process';
import type { SimpleGit } from 'simple-git';

/**
 * Turning a local-mode branch into a real pull or merge request.
 *
 * Local mode has no platform credential for the host — that is its whole point
 * (§11: code never leaves the machine unless the person running specd sends
 * it). But the machine specd is running on very often *is* signed in to the
 * host already, through `gh` or `glab`. Borrowing that is the one way to reach
 * a review surface without specd ever holding a token, which is why this shells
 * out to a CLI instead of calling an API.
 *
 * Everything here is best-effort by construction. The branch is already
 * committed before any of this runs, so a missing CLI, an unauthenticated one,
 * a remote that rejects the push — none of them are failures of the work, and
 * none of them may fail the run. Each returns a `note` saying what happened,
 * and the caller falls back to the compare URL it printed before this existed.
 */

export interface LocalReview {
  /** The PR/MR that now exists, or null if one could not be opened. */
  url: string | null;
  /** One clause for the review hint, describing what actually happened. */
  note: string;
}

export type HostKind = 'github' | 'gitlab';

export interface DetectedHost {
  kind: HostKind;
  /** `owner/repo`, or a GitLab group path. */
  path: string;
}

/**
 * Which host `origin` points at, when it is one we can address.
 *
 * Only github.com and gitlab.com are recognized: a self-managed host's
 * software cannot be inferred from its URL, and guessing wrong here would
 * mean running the wrong CLI against someone's private git server.
 */
export function detectHost(remoteUrl: string): DetectedHost | null {
  const m = remoteUrl
    .trim()
    .match(/^(?:git@|ssh:\/\/git@|https?:\/\/)(github\.com|gitlab\.com)[:/](.+?)(?:\.git)?\/?$/);
  if (!m) return null;
  const [, host, path] = m;
  return { kind: host === 'github.com' ? 'github' : 'gitlab', path: path! };
}

/** Is the host's CLI on PATH and signed in? */
export async function hostCliReady(kind: HostKind, cwd: string): Promise<boolean> {
  const bin = kind === 'github' ? 'gh' : 'glab';
  const { code } = await run(bin, ['auth', 'status'], { cwd, timeoutMs: 15_000 });
  return code === 0;
}

/**
 * Push the branch and open a review for it.
 *
 * The order matters and is deliberate: the CLI is checked *first*, so a repo
 * whose host specd cannot reach is never pushed to. Publishing a branch to
 * someone's remote is a side effect worth having only when it completes in the
 * thing that was asked for — a reviewable PR — and local mode should not be
 * quietly shipping code to a server to leave it sitting there.
 */
export async function openLocalReview(input: {
  git: SimpleGit;
  cwd: string;
  remoteUrl: string;
  branch: string;
  base: string;
  title: string;
  body: string;
}): Promise<LocalReview> {
  const { git, cwd, branch, base, title, body } = input;

  const host = detectHost(input.remoteUrl);
  if (!host) {
    return { url: null, note: 'its `origin` is not a host specd can open a review on' };
  }

  const bin = host.kind === 'github' ? 'gh' : 'glab';
  if (!(await hostCliReady(host.kind, cwd))) {
    return {
      url: null,
      note: `\`${bin}\` is not on PATH here, or is not signed in — specd holds no token of its own in local mode, so it had nothing else to open one with`,
    };
  }

  try {
    await git.push('origin', branch);
  } catch (err) {
    return { url: null, note: `pushing to origin failed (${short(err)})` };
  }

  const created = await createReview(host.kind, { cwd, branch, base, title, body });
  if (created) return { url: created, note: `pushed and opened ${label(host.kind)}` };

  // A review for this branch may already be open — a second setup run is a
  // normal thing to do, and both CLIs refuse to create a duplicate. Finding
  // the existing one is the correct outcome, not a fallback.
  const existing = await findReview(host.kind, { cwd, branch });
  if (existing) return { url: existing, note: `pushed; ${label(host.kind)} was already open` };

  return {
    url: null,
    note: `pushed the branch, but \`${bin}\` could not open ${label(host.kind)}`,
  };
}

function label(kind: HostKind): string {
  return kind === 'github' ? 'a pull request' : 'a merge request';
}

async function createReview(
  kind: HostKind,
  opts: { cwd: string; branch: string; base: string; title: string; body: string },
): Promise<string | null> {
  const { cwd, branch, base, title, body } = opts;

  // The description goes over stdin on both: a setup PR body is thousands of
  // characters of markdown, and putting that in an argv entry is how you meet
  // the platform's argument-length limit in someone else's repository.
  const { code, stdout } =
    kind === 'github'
      ? await run(
          'gh',
          ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body-file', '-'],
          { cwd, stdin: body },
        )
      : await run(
          'glab',
          [
            'mr',
            'create',
            '--source-branch',
            branch,
            '--target-branch',
            base,
            '--title',
            title,
            '--description',
            '-',
            '--yes',
          ],
          { cwd, stdin: body },
        );

  return code === 0 ? firstUrl(stdout) : null;
}

async function findReview(
  kind: HostKind,
  opts: { cwd: string; branch: string },
): Promise<string | null> {
  const { cwd, branch } = opts;
  const { code, stdout } =
    kind === 'github'
      ? await run('gh', ['pr', 'view', branch, '--json', 'url', '--jq', '.url'], { cwd })
      : await run('glab', ['mr', 'list', '--source-branch', branch], { cwd });

  return code === 0 ? firstUrl(stdout) : null;
}

/** Both CLIs print the review's URL; neither promises where on the line. */
function firstUrl(output: string): string | null {
  return output.match(/https?:\/\/\S+/)?.[0]?.replace(/[.,)]+$/, '') ?? null;
}

function short(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 160);
}

/**
 * A child process with a timeout, no shell, and no inherited stdio.
 *
 * No shell on purpose: `title` and `body` are repository- and project-derived
 * strings, and the moment they reach a shell they are code. As argv entries
 * they are data.
 */
function run(
  bin: string,
  args: string[],
  opts: { cwd: string; stdin?: string; timeoutMs?: number },
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Neither CLI may stop to ask a question: nobody is at this terminal.
        GH_PROMPT_DISABLED: '1',
        GH_NO_UPDATE_NOTIFIER: '1',
        GLAB_CHECK_UPDATE: '0',
        NO_COLOR: '1',
      },
    });

    let stdout = '';
    let settled = false;
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout });
    };

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      done(null);
    }, opts.timeoutMs ?? 60_000);

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    // stderr is drained but not kept: it is where both CLIs put their
    // "a pull request already exists" message, which is not an error worth
    // repeating to a user — `findReview` answers it with the URL instead.
    child.stderr.on('data', () => undefined);
    child.on('error', () => done(null));
    child.on('close', (code) => done(code));

    child.stdin.end(opts.stdin ?? '');
  });
}
