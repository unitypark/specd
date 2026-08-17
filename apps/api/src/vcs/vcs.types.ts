/**
 * The VCS boundary. Everything above this line — the onboarding agent, the
 * spec pipeline, the Learn step — is provider-agnostic; the adapters below it
 * differ only in how a change is proposed for review.
 *
 * The write path is the same everywhere and it is never a direct push:
 *   hosted providers → branch + pull request
 *   local mode       → branch, reviewed as a diff (no host account, no PRs)
 */

export interface RepoFile {
  path: string;
  content: string;
}

export interface RepoSnapshot {
  /** Every tracked path, for stack detection and layout summaries. */
  files: string[];
  /** Contents of the handful of manifests worth reading up front. */
  samples: RepoFile[];
  defaultBranch: string;
  headSha: string;
}

export interface ProposedChange {
  branch: string;
  title: string;
  body: string;
  files: RepoFile[];
}

export interface ChangeResult {
  branch: string;
  /** A PR/MR URL on hosted providers; null in local mode — there is no host. */
  url: string | null;
  /** What the human should do next, phrased for the UI. */
  reviewHint: string;
  filesWritten: number;
}

export interface RepoTarget {
  id: string;
  name: string;
  provider: string;
  localPath: string | null;
  externalId: string | null;
  defaultBranch: string;
  /**
   * The project this repository belongs to. Carried because local mode's
   * review credential lives on the project's connection, and `propose()` is
   * handed a target rather than a `Repository` row it could read it from.
   */
  projectId?: string;
}

/**
 * A credential local mode may use to open a review, and nothing else.
 *
 * Deliberately not the same thing as a VCS *connection*: a local-mode project
 * reads and writes its repository on disk, so this token never fetches a file,
 * never scans a tree and never pushes — the machine's own git does that. It
 * opens the pull or merge request and stops. That narrowness is what makes it
 * safe to add to the mode whose promise is that specd holds nothing.
 */
export interface LocalReviewCredential {
  provider: 'github' | 'gitlab';
  token: string;
  /** The instance root. gitlab.com / api.github.com when not self-managed. */
  instanceUrl: string | null;
}

export interface VcsAdapter {
  readonly provider: string;

  /** Read-only scan. The onboarding agent never gets write access to scan. */
  snapshot(repo: RepoTarget): Promise<RepoSnapshot>;

  /** Read a set of paths at HEAD (used to re-index knowledge/ after merge). */
  readFiles(repo: RepoTarget, paths: string[]): Promise<RepoFile[]>;

  /** List paths under a prefix at HEAD. */
  listFiles(repo: RepoTarget, prefix: string): Promise<string[]>;

  /**
   * The same listing with each file's content id — the git blob sha.
   *
   * Every provider already knows it: `git ls-files -s` prints it, and both
   * hosted tree APIs return it and used to throw it away. It is what lets an
   * index run tell "this file changed" from "this file is still here", which
   * is the difference between re-reading a repository and re-reading three
   * files.
   */
  listFilesWithSha(repo: RepoTarget, prefix: string): Promise<{ path: string; sha: string }[]>;

  /** Propose a change for human review. Never writes to the default branch. */
  propose(repo: RepoTarget, change: ProposedChange): Promise<ChangeResult>;
}

export class VcsError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'VcsError';
  }
}

/** What opening a review actually did, once a re-run is a normal thing to do. */
export interface OpenedReview {
  url: string;
  /** `#number` on GitHub, `!iid` on GitLab — the same thing to a reader. */
  number: number;
  /** One was already open for this branch and we updated it in place. */
  existing: boolean;
  /**
   * The description on the host no longer matches the branch. Only ever true
   * for an existing review whose rewrite failed: one we just opened carries
   * the description we opened it with.
   */
  descriptionStale: boolean;
}

/**
 * The one sentence a person gets when a run ends, in the four places that end
 * one. Kept together because the third case is easy to forget: a re-run whose
 * description could not be rewritten has updated the branch under a reviewer
 * without updating what the page tells them the branch contains, and silence
 * there reads as "this page is current".
 */
export function reviewHint(
  kind: 'PR' | 'MR',
  repoName: string,
  opened: Pick<OpenedReview, 'number' | 'existing' | 'descriptionStale'>,
): string {
  const ref = `${kind} ${kind === 'PR' ? '#' : '!'}${opened.number}`;
  const verb = opened.existing ? 'Updated' : 'Opened';
  const caveat = opened.descriptionStale
    ? ' Its description could not be rewritten and still describes the previous run.'
    : '';
  return `${verb} ${ref} on ${repoName}.${caveat} Merging is adopting.`;
}

/**
 * A self-managed instance URL, in a shape `fetch` will accept.
 *
 * Everything here exists because `fetch` rejects with a bare `TypeError` on a
 * URL it cannot parse, and a `TypeError` is not an `HttpException` — so it
 * reaches the client as "Internal server error", which tells someone who typed
 * their host without a scheme precisely nothing.
 *
 * `gitlab.example.com` is what people type, and it is not a URL: WHATWG reads
 * the host as a *scheme*. Rather than refuse it, assume https — that is what
 * was meant every time, and a self-managed GitLab served over plain http is
 * still reachable by typing `http://` explicitly.
 */
export function normalizeInstanceUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new VcsError('No instance URL was given.');

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new VcsError(
      `"${raw}" is not a URL specd can reach. Give the instance's origin, e.g. ` +
        'https://gitlab.example.com — or leave it blank for gitlab.com.',
    );
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new VcsError(
      `"${raw}" uses ${url.protocol.replace(':', '')}, and specd speaks only http and https. ` +
        'Give the instance\'s origin, e.g. https://gitlab.example.com.',
    );
  }

  // The path is KEPT, and that is not an oversight. GitLab supports being
  // served from a relative URL root — `external_url 'https://host/gitlab'` —
  // where the API really is at `{origin}/gitlab/api/v4`. Reducing this to the
  // origin would be a convenience for someone pasting a project URL bought by
  // breaking every subpath-hosted instance, and only one of those two is a
  // deployment somebody chose. A pasted project URL instead 404s at the API
  // base, which `describeApiBase404` explains.
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

/**
 * The 404 a wrong instance URL produces, explained.
 *
 * Reaching a real host that answers 404 to `/api/v4/...` means one of two
 * things, and they look identical from here: the URL carries a path that is
 * not GitLab's root (a project URL pasted out of the address bar), or the
 * instance is not a GitLab. Both are worth saying, because a bare "404" sends
 * someone to check their token, which is the one thing that is fine.
 */
export function describeApiBase404(instanceUrl: string): string {
  const path = (() => {
    try {
      return new URL(instanceUrl).pathname.replace(/\/+$/, '');
    } catch {
      return '';
    }
  })();

  return (
    `${instanceUrl} answered, but has no GitLab API at ${instanceUrl}/api/v4.` +
    (path
      ? ` The instance URL includes the path "${path}" — if that is a group or project rather than ` +
        `GitLab's own root, drop it and use ${new URL(instanceUrl).origin}. Keep it only if GitLab ` +
        'itself is served from that subpath.'
      : ' Check this is a GitLab instance and that the host is right.')
  );
}

/**
 * Why a request never reached the host, phrased for the person who configured
 * it. `fetch` reports every transport failure as `TypeError: fetch failed`
 * with the real reason on `cause.code`, and a self-managed instance is where
 * every one of these actually happens: behind a VPN, on an internal DNS name,
 * behind a certificate the machine does not trust.
 */
export function describeTransportFailure(err: unknown, host: string): string | null {
  if (!(err instanceof TypeError)) return null;

  const code = (err.cause as { code?: string } | undefined)?.code ?? '';
  const detail =
    {
      ENOTFOUND: `${host} does not resolve from the machine specd runs on. Check the hostname, and whether this machine needs to be on your VPN.`,
      EAI_AGAIN: `${host} could not be resolved right now — a DNS failure rather than a wrong name. Check the machine's network.`,
      ECONNREFUSED: `${host} refused the connection. The host resolves, so check the port and that the instance is actually serving there.`,
      ETIMEDOUT: `${host} did not answer in time — typically a firewall or a VPN that is not connected.`,
      UNABLE_TO_VERIFY_LEAF_SIGNATURE: `${host} presented a certificate this machine does not trust. Self-managed instances behind an internal CA need that CA installed where specd runs (NODE_EXTRA_CA_CERTS).`,
      DEPTH_ZERO_SELF_SIGNED_CERT: `${host} presented a self-signed certificate. Install its CA where specd runs (NODE_EXTRA_CA_CERTS) rather than disabling verification.`,
      SELF_SIGNED_CERT_IN_CHAIN: `${host} presented a self-signed certificate in its chain. Install its CA where specd runs (NODE_EXTRA_CA_CERTS).`,
      CERT_HAS_EXPIRED: `${host} presented an expired certificate.`,
    }[code] ?? `${host} could not be reached (${code || err.message}).`;

  return `Could not reach ${host}. ${detail}`;
}

/**
 * Root files worth reading in full during a scan — small, high-signal, cheap.
 * This is the first tier of the scan; `scan-targets.ts` adds the rest (CI,
 * workspace manifests, schemas, docs, entry points) under per-tier caps.
 */
export const MANIFEST_FILES = [
  'package.json',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'turbo.json',
  'nx.json',
  'deno.json',
  'pyproject.toml',
  'requirements.txt',
  'setup.py',
  'go.mod',
  'go.work',
  'Cargo.toml',
  'Gemfile',
  'mix.exs',
  'pubspec.yaml',
  'Package.swift',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'composer.json',
  'README.md',
  'readme.md',
  'README.rst',
  'CONTRIBUTING.md',
  'ARCHITECTURE.md',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'Dockerfile',
  'Makefile',
  'Taskfile.yml',
  'justfile',
  '.env.example',
  '.env.sample',
  '.env.template',
  // Agent instructions the repo already has. Onboarding must read these before
  // it proposes its own — overwriting a team's existing rules is not onboarding.
  'AGENTS.md',
  'CLAUDE.md',
  '.cursorrules',
];

/** Paths never worth scanning — noise that would drown the signal. */
export const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  'coverage',
  'vendor',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.terraform',
  '.gradle',
  '.idea',
  '.vscode',
]);
