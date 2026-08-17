import { collectSamples } from './scan-targets.js';
import {
  IGNORED_DIRS,
  VcsError,
  describeApiBase404,
  describeNonJsonBody,
  describeTransportFailure,
  normalizeInstanceUrl,
  reviewHint,
  type ChangeResult,
  type OpenedReview,
  type ProposedChange,
  type RepoFile,
  type RepoSnapshot,
  type RepoTarget,
  type VcsAdapter,
} from './vcs.types.js';

/**
 * GitLab adapter (§11). Same contract as GitHub — a branch plus a merge
 * request, never a direct push — with two shapes GitLab actually has instead
 * of GitHub's:
 *
 * A **personal or project access token** (`api` scope), not an App. There is
 * no equivalent of a GitHub App installation to mint short-lived scoped
 * tokens from, so the token is whatever the connection was given, for as long
 * as it is valid — the same trade-off GitHub PATs make, and the reason the
 * GitHub App exists at all. A gitlab.com OAuth app is optional wiring on top
 * of this class, not a change to it, exactly the relationship the GitHub App
 * has to a raw PAT there — and self-managed instances need a token regardless,
 * since an OAuth app would have to be registered per instance.
 *
 * A **self-managed instance URL**, since GitLab is commonly run on-prem
 * behind a VPN. Every request is relative to `{instanceUrl}/api/v4`, and
 * `instanceUrl` defaults to gitlab.com.
 *
 * The token is supplied per call by the caller, which decrypts it from the
 * vault inside the run that needs it (mirrors `GitHubAdapter`) — this class
 * never reads the vault and never holds a credential beyond the request.
 */
export class GitLabAdapter implements VcsAdapter {
  readonly provider = 'gitlab';
  private readonly apiBase: string;
  /** The instance root, for error messages — `apiBase` has `/api/v4` glued on. */
  private readonly origin: string;
  /** Has any call to this instance succeeded? Decides what a 404 means. */
  private reachedApi = false;

  constructor(
    private readonly token: string,
    instanceUrl = 'https://gitlab.com',
  ) {
    if (!token) {
      throw new VcsError('GitLab is connected but no token is available. Reconnect it in project settings.');
    }
    // Normalized here as well as at the point it is stored, because a
    // connection saved before that existed still has whatever was typed, and
    // this class is the last place that can turn it into something `fetch`
    // will accept rather than a 500.
    this.origin = normalizeInstanceUrl(instanceUrl);
    this.apiBase = `${this.origin}/api/v4`;
  }

  /** The instance this adapter talks to, normalized. */
  get instanceUrl(): string {
    return this.origin;
  }

  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.apiBase}${path}`, {
        ...init,
        headers: {
          'PRIVATE-TOKEN': this.token,
          'Content-Type': 'application/json',
          ...(init.headers ?? {}),
        },
      });
    } catch (err) {
      // `fetch` rejects with a TypeError when the request never reached the
      // host at all. Left alone it escapes as an opaque 500, which is the
      // least useful thing to tell someone whose instance is behind a VPN.
      const explained = describeTransportFailure(err, this.origin);
      if (explained) throw new VcsError(explained, err);
      throw err;
    }

    if (!res.ok) {
      const body = await res.text();
      // A 404 straight off the API base is a wrong instance URL far more often
      // than a missing resource, and "404" alone sends people to check their
      // token — the one thing that is not the problem.
      if (res.status === 404 && !this.reachedApi) {
        throw new VcsError(describeApiBase404(this.origin));
      }
      throw new VcsError(
        `GitLab ${init.method ?? 'GET'} ${path} → ${res.status}: ${body.slice(0, 300)}`,
      );
    }

    // 204 (branch delete) has no body.
    if (res.status === 204) {
      this.reachedApi = true;
      return undefined as T;
    }

    // Parsed here rather than with `res.json()` so a body that is not JSON
    // becomes a VcsError naming the cause. Unguarded it throws a SyntaxError,
    // which is not an HttpException and so reaches a user as an opaque 500 or
    // a parser complaining about a doctype — the same shape of failure the
    // transport guard above exists to prevent.
    const body = await res.text();
    try {
      const parsed = JSON.parse(body) as T;
      // From here on a 404 means what it says: this instance answered as a
      // GitLab API, so a missing project is a missing project.
      this.reachedApi = true;
      return parsed;
    } catch {
      throw new VcsError(describeNonJsonBody(`${this.origin}/api/v4${path.split('?')[0]}`, body));
    }
  }

  /** `namespace/project`, which is what we store as the repository name. */
  private id(repo: Pick<RepoTarget, 'name'>): string {
    if (!repo.name.includes('/')) {
      throw new VcsError(`GitLab repository name must be "namespace/project", got "${repo.name}"`);
    }
    return encodeURIComponent(repo.name);
  }

  async snapshot(repo: RepoTarget): Promise<RepoSnapshot> {
    const id = this.id(repo);
    const meta = await this.api<{ default_branch: string }>(`/projects/${id}`);
    const defaultBranch = meta.default_branch || repo.defaultBranch;

    const [commit, tree] = await Promise.all([
      this.api<{ id: string }>(`/projects/${id}/repository/commits/${encodeURIComponent(defaultBranch)}`),
      this.tree(id, defaultBranch),
    ]);

    const files = tree
      .filter((n) => n.type === 'blob')
      .map((n) => n.path)
      .filter((p) => !p.split('/').some((seg) => IGNORED_DIRS.has(seg)));

    const samples = await collectSamples(files, async (target) => {
      const [file] = await this.readFilesAt(repo, [target.path], defaultBranch);
      return file ?? null;
    });

    return { files, samples, defaultBranch, headSha: commit.id };
  }

  /**
   * The repository tree, paginated. GitLab caps a page at 100 entries instead
   * of GitHub's one-call-with-a-truncated-flag, so getting the whole tree
   * means following `X-Next-Page` until it is empty. Capped at 50 pages
   * (5,000 entries) — enough for any repo worth scanning for a manifest file,
   * and a runaway loop is worse than an incomplete scan on the rare monorepo
   * past that.
   */
  private async tree(
    id: string,
    ref: string,
  ): Promise<{ path: string; type: string; id: string }[]> {
    const out: { path: string; type: string; id: string }[] = [];
    let page = '1';

    for (let i = 0; i < 50 && page; i++) {
      const res = await fetch(
        `${this.apiBase}/projects/${id}/repository/tree` +
          `?recursive=true&per_page=100&page=${page}&ref=${encodeURIComponent(ref)}`,
        { headers: { 'PRIVATE-TOKEN': this.token } },
      );
      if (!res.ok) {
        throw new VcsError(`GitLab GET repository/tree → ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const body = await res.text();
      try {
        out.push(...(JSON.parse(body) as { path: string; type: string; id: string }[]));
      } catch {
        throw new VcsError(describeNonJsonBody(`${this.origin}/api/v4/projects/${id}/repository/tree`, body));
      }
      page = res.headers.get('x-next-page') ?? '';
    }

    return out;
  }

  async readFiles(repo: RepoTarget, paths: string[]): Promise<RepoFile[]> {
    return this.readFilesAt(repo, paths, repo.defaultBranch);
  }

  private async readFilesAt(repo: RepoTarget, paths: string[], ref: string): Promise<RepoFile[]> {
    const id = this.id(repo);
    const out: RepoFile[] = [];
    for (const path of paths) {
      try {
        const res = await this.api<{ content?: string; encoding?: string }>(
          `/projects/${id}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`,
        );
        if (res.content && res.encoding === 'base64') {
          out.push({ path, content: Buffer.from(res.content, 'base64').toString('utf8') });
        }
      } catch {
        // Missing file — the caller's list is a request, not a guarantee.
      }
    }
    return out;
  }

  async listFiles(repo: RepoTarget, prefix: string): Promise<string[]> {
    const snap = await this.snapshot(repo);
    return snap.files.filter((f) => f.startsWith(prefix));
  }

  async listFilesWithSha(
    repo: RepoTarget,
    prefix: string,
  ): Promise<{ path: string; sha: string }[]> {
    const id = this.id(repo);
    const branch = repo.defaultBranch;
    // A GitLab tree entry's `id` is the blob sha.
    return (await this.tree(id, branch))
      .filter((n) => n.type === 'blob' && n.path.startsWith(prefix))
      .map((n) => ({ path: n.path, sha: n.id }));
  }

  private async fileExistsAt(id: string, path: string, ref: string): Promise<boolean> {
    try {
      await this.api(`/projects/${id}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`);
      return true;
    } catch {
      return false;
    }
  }

  private async deleteBranchIfExists(id: string, branch: string): Promise<void> {
    try {
      await this.api(`/projects/${id}/repository/branches/${encodeURIComponent(branch)}`, {
        method: 'DELETE',
      });
    } catch {
      // Nothing to delete, or it never existed — either way the branch we are
      // about to create starts clean.
    }
  }

  async propose(repo: RepoTarget, change: ProposedChange): Promise<ChangeResult> {
    const id = this.id(repo);
    const meta = await this.api<{ default_branch: string }>(`/projects/${id}`);
    const base = meta.default_branch;

    // Reset to the tip of the default branch every time, the same way the
    // GitHub adapter force-resets its ref: a re-run must not layer new
    // content on top of a previous run's commit.
    await this.deleteBranchIfExists(id, change.branch);

    const actions = await Promise.all(
      change.files.map(async (file) => ({
        action: (await this.fileExistsAt(id, file.path, base)) ? ('update' as const) : ('create' as const),
        file_path: file.path,
        content: file.content,
      })),
    );

    await this.api(`/projects/${id}/repository/commits`, {
      method: 'POST',
      body: JSON.stringify({
        branch: change.branch,
        start_branch: base,
        commit_message: `${change.title}\n\n${change.body.split('\n')[0] ?? ''}`,
        actions,
      }),
    });

    const mr = await this.openMergeRequest(repo.name, {
      branch: change.branch,
      base,
      title: change.title,
      body: change.body,
    });

    return {
      branch: change.branch,
      url: mr.url,
      reviewHint: reviewHint('MR', repo.name, mr),
      filesWritten: change.files.length,
    };
  }

  /**
   * Open an MR for `branch`, or update the one already open for it — shared by
   * `propose` and the build station, mirroring `GitHubAdapter.openPullRequest`
   * down to rewriting the description, which describes one run and not the
   * next. A re-run must update the open MR rather than fail on it, so an
   * existing one is brought up to date rather than treated as an error.
   */
  async openMergeRequest(
    name: string,
    mr: { branch: string; base: string; title: string; body: string },
  ): Promise<OpenedReview> {
    const id = encodeURIComponent(name);
    try {
      const created = await this.api<{ web_url: string; iid: number }>(`/projects/${id}/merge_requests`, {
        method: 'POST',
        body: JSON.stringify({
          source_branch: mr.branch,
          target_branch: mr.base,
          title: mr.title,
          description: mr.body,
        }),
      });
      return { url: created.web_url, number: created.iid, existing: false, descriptionStale: false };
    } catch (err) {
      // GitLab refuses a second open MR for the same source/target — finding
      // it is the correct outcome, not a fallback.
      const open = await this.api<{ web_url: string; iid: number }[]>(
        `/projects/${id}/merge_requests?source_branch=${encodeURIComponent(mr.branch)}&state=opened`,
      ).catch(() => []);

      const found = open[0];
      if (!found) throw err;

      // Best-effort, as on GitHub: the branch is pushed and the MR exists, so
      // this is the one call in the sequence not worth failing a run over.
      const descriptionStale = await this.api(`/projects/${id}/merge_requests/${found.iid}`, {
        method: 'PUT',
        body: JSON.stringify({ title: mr.title, description: mr.body }),
      }).then(
        () => false,
        () => true,
      );

      return { url: found.web_url, number: found.iid, existing: true, descriptionStale };
    }
  }

  /** Repo picker source (§6 step 2, §11): what the token can see, searchable. */
  /**
   * Prove the token, and say who it belongs to.
   *
   * Called at connect time so a bad token fails in the wizard, where a person
   * is looking at it, rather than later inside a run — the same role
   * `JiraAdapter.verify()` plays, and the same reason.
   */
  async verify(): Promise<{ username: string; name: string }> {
    const me = await this.api<{ username: string; name: string }>('/user');
    return { username: me.username, name: me.name };
  }

  async listRepositories(
    search?: string,
  ): Promise<{ id: string; fullName: string; defaultBranch: string; namespace: string }[]> {
    const qs = new URLSearchParams({
      membership: 'true',
      simple: 'true',
      per_page: '50',
      order_by: 'last_activity_at',
    });
    if (search) qs.set('search', search);

    const res = await this.api<
      { id: number; path_with_namespace: string; default_branch: string | null; namespace: { full_path: string } }[]
    >(`/projects?${qs.toString()}`);

    return res.map((p) => ({
      id: String(p.id),
      fullName: p.path_with_namespace,
      defaultBranch: p.default_branch || 'main',
      namespace: p.namespace?.full_path ?? p.path_with_namespace.split('/').slice(0, -1).join('/'),
    }));
  }

  /**
   * Register specd's webhook on one project. Unlike a GitHub App, there is no
   * account-level hook — every GitLab repository needs its own, created with
   * whatever role the token holds (Maintainer or above). A token without that
   * role gets a 403 here, which the caller surfaces rather than treats as a
   * fatal add-repository error (§11: this degrades gracefully, same as local
   * mode's missing webhook — the repo still works, merges just are not
   * detected until someone fixes the token's role).
   */
  async registerWebhook(name: string, webhookUrl: string, secret: string): Promise<{ id: number }> {
    const id = encodeURIComponent(name);
    return this.api<{ id: number }>(`/projects/${id}/hooks`, {
      method: 'POST',
      body: JSON.stringify({
        url: webhookUrl,
        token: secret,
        push_events: true,
        merge_requests_events: true,
        enable_ssl_verification: true,
      }),
    });
  }
}
