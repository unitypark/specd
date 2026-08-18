import { spawn } from 'node:child_process';
import type { SimpleGit } from 'simple-git';
import { fetchOrExplain } from '../common/http-failures.js';
import { GitHubAdapter } from './github.adapter.js';
import { GitLabAdapter } from './gitlab.adapter.js';
import type { LocalReviewCredential } from './vcs.types.js';

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
  /** Configured for the project, if any. Takes precedence over the host CLI. */
  credential?: LocalReviewCredential | null;
}): Promise<LocalReview> {
  const { git, cwd, branch, base, title, body, credential } = input;

  // A configured credential settles what the host is, which is the thing
  // `detectHost` refuses to guess. So a self-managed instance is reachable
  // through this path and only this path.
  const kind: HostKind | null = credential?.provider ?? detectHost(input.remoteUrl)?.kind ?? null;
  if (!kind) {
    return {
      url: null,
      note:
        'its `origin` is not github.com or gitlab.com, and no review credential is configured — ' +
        'specd will not guess what software a self-managed host runs',
    };
  }

  // GitLab first, and without asking for anything: push options open the merge
  // request over the git transport, so this path needs no credential, no CLI
  // and no reachable API. It is the only strategy that survives an access
  // portal in front of `/api/v4`.
  if (kind === 'gitlab') {
    const viaPush = await pushOpeningMergeRequest(cwd, { branch, base, title, body });
    if (viaPush.url) {
      return {
        url: viaPush.url,
        note: 'pushed, and GitLab opened the merge request from the push itself — no API call, no token',
      };
    }
    if (viaPush.pushed) {
      // The branch is published; only the announcement is missing. An older
      // GitLab, or a project with merge requests disabled, lands here — and
      // the API path below may still succeed where the push option did not.
      if (!credential?.token) {
        return {
          url: null,
          note:
            'pushed the branch, but GitLab did not report a merge request from the push ' +
            '(push options need GitLab 11.10 or newer, and merge requests enabled on the project)',
        };
      }
      return openWithToken(
        { ...credential, token: credential.token },
        { remoteUrl: input.remoteUrl, branch, base, title, body },
      );
    }
    return { url: null, note: `pushing to origin failed (${viaPush.detail})` };
  }

  const bin = kind === 'github' ? 'gh' : 'glab';
  const viaCli = !credential?.token;
  if (viaCli && !(await hostCliReady(kind, cwd))) {
    return {
      url: null,
      note: `\`${bin}\` is not on PATH here, or is not signed in — and this project has no review credential, so specd had nothing to open one with`,
    };
  }

  // The push is git's, with the machine's own credentials, in every case. The
  // token below opens the review and does nothing else — it never fetches a
  // file, scans a tree, or writes a commit.
  try {
    await git.push(['--force-with-lease', 'origin', branch]);
  } catch (err) {
    return { url: null, note: `pushing to origin failed (${short(err)})` };
  }

  if (credential?.token) {
    return openWithToken(
      { ...credential, token: credential.token },
      { remoteUrl: input.remoteUrl, branch, base, title, body },
    );
  }

  const created = await createReview(kind, { cwd, branch, base, title, body });
  if (created) return { url: created, note: `pushed and opened ${label(kind)}` };

  // A review for this branch may already be open — a second setup run is a
  // normal thing to do, and both CLIs refuse to create a duplicate. Finding
  // the existing one is the correct outcome, not a fallback.
  const existing = await findReview(kind, { cwd, branch });
  if (existing) return { url: existing, note: `pushed; ${label(kind)} was already open` };

  return {
    url: null,
    note: `pushed the branch, but \`${bin}\` could not open ${label(kind)}`,
  };
}

/**
 * Which URL is the instance root: the host, or the host plus one path segment?
 *
 * `https://host/ET130/services/api` is two deployments wearing one string —
 * GitLab at the root with `ET130` a group, or GitLab served from `/ET130`
 * with `services/api` the project. Nothing in the remote distinguishes them,
 * and both are legitimate, so specd asks instead of guessing: one unauthenticated
 * `GET {candidate}/api/v4/version`, which answers 401 when GitLab is there and
 * 404 when it is not.
 *
 * Root wins on a tie because subpath installs are rare. Returns the candidate
 * unchanged when neither answers — a wrong instance URL is then reported by
 * `describeApiBase404`, which says which half to drop.
 */
export async function resolveGitLabRoot(
  candidateRoot: string,
  remoteUrl: string,
  probe: (url: string) => Promise<number | null> = probeStatus,
): Promise<string> {
  if (await looksLikeGitLab(candidateRoot, probe)) return candidateRoot;

  const firstSegment = (projectPathFromRemote(remoteUrl) ?? '').split('/')[0];
  if (!firstSegment) return candidateRoot;

  const nested = `${candidateRoot}/${firstSegment}`;
  return (await looksLikeGitLab(nested, probe)) ? nested : candidateRoot;
}

async function looksLikeGitLab(
  root: string,
  probe: (url: string) => Promise<number | null>,
): Promise<boolean> {
  // 401 is the *expected* answer: /version needs auth, and only a GitLab
  // answers it that way. 200 covers instances that allow it unauthenticated.
  const status = await probe(`${root}/api/v4/version`);
  return status === 200 || status === 401;
}

async function probeStatus(url: string): Promise<number | null> {
  try {
    const res = await fetchOrExplain(url, {}, { host: url, wrap: (m) => new Error(m) });
    return res.status;
  } catch {
    return null;
  }
}

/**
 * Ask GitLab to open the merge request as part of the push itself.
 *
 * This is the only strategy here that needs no credential and no reachable
 * API. Push options travel over the git transport — the same SSH connection
 * the person already pushes through every day — so it works where an access
 * portal intercepts `/api/v4` and answers with a login page, which is the one
 * failure a token cannot solve.
 *
 * GitLab announces the result in the push's remote messages, which is why
 * `run()` keeps stderr. Both "created" and "an MR already exists" print a URL,
 * and either is the right answer for a re-run.
 *
 * GitHub has no equivalent: pull requests there are API-only.
 */
async function pushOpeningMergeRequest(
  cwd: string,
  pr: { branch: string; base: string; title: string; body: string },
): Promise<{ pushed: boolean; url: string | null; detail: string }> {
  const { code, stderr, stdout } = await run(
    'git',
    [
      'push',
      '-o',
      'merge_request.create',
      '-o',
      `merge_request.target=${pr.base}`,
      '-o',
      `merge_request.title=${pr.title}`,
      '-o',
      `merge_request.description=${describeForPushOption(pr.body)}`,
      // The branch belongs to this spec, and a re-run resets it — the same
      // reason the hosted adapters force-push. `--force-with-lease` refuses if
      // the remote moved in a way we have not seen, which is the safe half of
      // that bargain.
      '--force-with-lease',
      'origin',
      pr.branch,
    ],
    { cwd },
  );

  const output = `${stderr}\n${stdout}`;
  if (code === 0) {
    return { pushed: true, url: firstUrl(pickMergeRequestLine(output) ?? output), detail: '' };
  }

  // A remote that does not take push options rejects the whole push and sends
  // nothing — GitLab before 11.10, and every non-GitLab remote. The branch
  // still has to get there, so it goes again without them and the merge
  // request is left to whatever strategy comes next.
  const plain = await run(
    'git',
    ['push', '--force-with-lease', 'origin', pr.branch],
    { cwd },
  );
  if (plain.code === 0) return { pushed: true, url: null, detail: '' };

  return {
    pushed: false,
    url: null,
    detail: firstLine(`${plain.stderr}\n${plain.stdout}`) || firstLine(output) || 'git push failed',
  };
}

/**
 * GitLab prints several URLs on a push. The one on the merge-request line is
 * the merge request; the others are the project and, on a first push, the
 * "create a merge request" form. Taking the first URL anywhere in the output
 * would hand someone the form instead of the thing that was just opened.
 */
function pickMergeRequestLine(output: string): string | null {
  return (
    output
      .split('\n')
      .find((line) => /merge[ _]request/i.test(line) && /https?:\/\//.test(line)) ?? null
  );
}

/**
 * A push option is one argv string, and a build's description is a page of
 * markdown. Git imposes no limit but servers do, and a push rejected for a
 * long description would lose the merge request over its own body — so it is
 * trimmed, and says that it was.
 */
export function describeForPushOption(body: string, limit = 1500): string {
  if (body.length <= limit) return body;
  return `${body.slice(0, limit).trimEnd()}\n\n_(truncated — specd sent this description over a git push option, which cannot carry the whole body.)_`;
}

function firstLine(output: string): string {
  return output.split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? '';
}

/**
 * Open the review over the provider's API with the project's own token.
 *
 * Both adapters already know how to open one *or* update the one that is
 * already open for the branch, which is what a re-run needs — so this is
 * genuinely just picking which of them to call.
 */
async function openWithToken(
  credential: LocalReviewCredential & { token: string },
  pr: { remoteUrl: string; branch: string; base: string; title: string; body: string },
): Promise<LocalReview> {
  // The host the clone already names. Without this, a blank instance URL fell
  // through to the adapter's `https://gitlab.com` default and quietly sent a
  // self-managed project's path and token to gitlab.com.
  const root = credential.instanceUrl ?? instanceUrlFromRemote(pr.remoteUrl);
  if (!root) {
    return {
      url: null,
      note: `pushed the branch, but could not work out which host to open a review on from \`origin\` (${pr.remoteUrl})`,
    };
  }

  const path = projectPathFromRemote(pr.remoteUrl, root);
  if (!path) {
    return {
      url: null,
      note: `pushed the branch, but could not read a project path out of \`origin\` (${pr.remoteUrl})`,
    };
  }

  try {
    const opened =
      credential.provider === 'gitlab'
        ? await new GitLabAdapter(credential.token, root).openMergeRequest(
            path,
            { branch: pr.branch, base: pr.base, title: pr.title, body: pr.body },
          )
        : await new GitHubAdapter(
            credential.token,
            // github.com's API lives on its own host; an Enterprise Server
            // serves it under /api/v3 on the instance itself.
            /^https:\/\/github\.com$/.test(root) ? undefined : `${root}/api/v3`,
          ).openPullRequest(path, {
            branch: pr.branch,
            base: pr.base,
            title: pr.title,
            body: pr.body,
          });

    const what = label(credential.provider);
    return {
      url: opened.url,
      note: opened.existing
        ? `pushed; ${what} was already open and was brought up to date`
        : `pushed and opened ${what} with this project's token`,
    };
  } catch (err) {
    return { url: null, note: `pushed the branch, but opening a review failed (${short(err)})` };
  }
}

/**
 * The `namespace/project` path a remote URL points at.
 *
 * Handles the three spellings git uses and, when the instance is served from
 * a subpath, removes it — `https://host/gitlab/group/project.git` is the
 * project `group/project` on the GitLab at `https://host/gitlab`, and passing
 * the subpath through would address a project that does not exist.
 */
export function projectPathFromRemote(remoteUrl: string, instanceRoot?: string | null): string | null {
  let path = remotePath(remoteUrl);
  if (path === null) return null;

  if (instanceRoot) {
    const root = (() => {
      try {
        return new URL(instanceRoot).pathname.replace(/^\/+|\/+$/g, '');
      } catch {
        return '';
      }
    })();
    // Compared without leading slashes on either side. They used to be
    // compared as-is, and `URL.pathname` has a leading slash while the
    // scp-syntax branch does not — so a subpath-hosted instance stripped its
    // prefix from an https remote and silently kept it on an ssh one, which is
    // the syntax a corporate clone actually uses.
    if (root && (path === root || path.startsWith(`${root}/`))) {
      path = path.slice(root.length).replace(/^\/+/, '');
    }
  }

  return path.includes('/') ? path : null;
}

/**
 * The path part of a remote, in either syntax git accepts, without leading or
 * trailing slashes and without `.git`.
 */
function remotePath(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim().replace(/\.git\/?$/, '');
  if (!trimmed) return null;

  // scp-like syntax (`git@host:group/project`) is not a URL, so it is matched
  // rather than parsed. Everything else goes through URL.
  const scp = trimmed.match(/^[^/]+@([^:]+):(.+)$/);
  const raw = scp
    ? scp[2]!
    : (() => {
        try {
          return new URL(trimmed).pathname;
        } catch {
          return '';
        }
      })();

  return raw.replace(/^\/+|\/+$/g, '');
}

/**
 * The instance a clone already names.
 *
 * A local checkout knows its host — asking someone to retype it is asking for
 * something the repository is holding. What cannot be read off a remote is
 * *which software* the host runs, so the provider is still chosen by hand
 * ([[0020-local-mode-borrows-the-host-cli]]); this only supplies the address.
 *
 * https is assumed, and any port is dropped. An ssh remote's port is the SSH
 * port — carrying `:2222` onto an API URL would be confidently wrong, and a
 * genuinely non-standard API port is what the override field is for.
 */
export function instanceUrlFromRemote(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;

  const scp = trimmed.match(/^[^/]+@([^:]+):/);
  if (scp) return `https://${scp[1]!.toLowerCase()}`;

  try {
    const url = new URL(trimmed);
    if (!url.hostname) return null;
    // An https remote's port is the web port and worth keeping; ssh:// carries
    // the SSH one, which is not.
    const port = url.protocol === 'ssh:' ? '' : url.port ? `:${url.port}` : '';
    const scheme = url.protocol === 'http:' ? 'http' : 'https';
    return `${scheme}://${url.hostname.toLowerCase()}${port}`;
  } catch {
    return null;
  }
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
 *
 * Exported for one test: the stdin race below is a property of this function
 * and not of any caller, and reproducing it through `openLocalReview` means
 * depending on which binaries the machine happens to have.
 */
export function run(
  bin: string,
  args: string[],
  opts: { cwd: string; stdin?: string; timeoutMs?: number },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
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
    let stderr = '';
    let settled = false;
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      done(null);
    }, opts.timeoutMs ?? 60_000);

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    // Kept, not discarded. For the CLIs it holds "a pull request already
    // exists", which `findReview` answers with a URL instead — but for `git
    // push` it is where the server's own messages arrive, and GitLab announces
    // the merge request it just opened in exactly that channel.
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', () => done(null));
    child.on('close', (code) => done(code));

    // `gh` and `git` both exit before reading stdin in the common failure
    // cases — a missing binary, a rejected push — leaving the pipe with nobody
    // on the other end. Node reports that write as an `error` on the stream,
    // and unhandled it is an uncaught exception rather than a failed call.
    // Same guard the runner arrived at (`apps/runner/src/claude.ts`); the exit
    // code and stderr already carry the outcome.
    child.stdin.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') return;
      stderr += `\n[specd] could not write to ${bin}'s stdin: ${err.message}`;
    });
    child.stdin.end(opts.stdin ?? '');
  });
}
