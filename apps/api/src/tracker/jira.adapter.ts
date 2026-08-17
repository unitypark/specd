/**
 * Jira Cloud, over the v3 REST API.
 *
 * Auth is an Atlassian account email plus an API token, sent as HTTP Basic —
 * not 3LO OAuth, for the reasons in
 * `knowledge/decisions/0010-jira-via-api-token-and-a-mirror-that-cannot-fail.md`.
 * Every request goes through `api()`, so swapping in a bearer token later
 * touches one method.
 *
 * Cloud only. Jira Server/Data Center has a different base path and different
 * auth, and pretending to support it by accepting a URL would fail confusingly
 * rather than clearly.
 */

import {
  fetchOrExplain,
  normalizeServiceUrl,
  readJsonOrExplain,
} from '../common/http-failures.js';

export class JiraError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'JiraError';
  }
}

export interface JiraProject {
  id: string;
  key: string;
  name: string;
}

export interface JiraIssue {
  key: string;
  summary: string;
  description: string;
  status: string;
  url: string;
}

export interface JiraTransition {
  id: string;
  name: string;
  /** The status this transition lands the issue in. */
  to: string;
}

export class JiraAdapter {
  readonly provider = 'jira';
  private readonly base: string;
  private readonly auth: string;
  /** The site origin, for error messages — `base` has the API path glued on. */
  private readonly origin: string;

  constructor(
    readonly siteUrl: string,
    email: string,
    apiToken: string,
  ) {
    if (!siteUrl) throw new JiraError('Jira is connected but no site URL is stored.');
    if (!email || !apiToken) {
      throw new JiraError('Jira is connected but no credential is available. Reconnect it in project settings.');
    }
    // Normalized rather than merely de-slashed: a site URL typed without a
    // scheme is not a URL, and `fetch` answers that with a TypeError whose
    // message is about parsing — which used to be handed to the user as
    // "Jira rejected that credential", blaming the one thing that was fine.
    this.origin = normalizeServiceUrl(siteUrl, (message) => new JiraError(message));
    this.base = `${this.origin}/rest/api/3`;
    this.auth = Buffer.from(`${email}:${apiToken}`, 'utf8').toString('base64');
  }

  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetchOrExplain(
      `${this.base}${path}`,
      {
        ...init,
        headers: {
          Authorization: `Basic ${this.auth}`,
          Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...(init.headers ?? {}),
        },
      },
      { host: this.origin, wrap: (message) => new JiraError(message) },
    );

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // Jira answers several failures with an empty body, so the status code
      // is all there is to go on. Saying "404" to someone who mistyped their
      // site URL is not an answer; saying which of the three things they
      // typed is wrong usually is.
      const explanation = describeJiraError(body) || hintForStatus(res.status) || res.statusText;
      throw new JiraError(`Jira ${init.method ?? 'GET'} ${path} → ${res.status}: ${explanation}`, res.status);
    }

    // 204 on transitions and some comment operations — handled inside, because
    // an empty body is not a broken one.
    return readJsonOrExplain<T>(res, {
      url: `${this.base}${path.split('?')[0]}`,
      wrap: (message) => new JiraError(message),
    });
  }

  /**
   * Prove the credential, and say who it belongs to.
   *
   * Called at connect time so a bad token fails in the wizard, where a person
   * is looking at it, rather than later inside a spec run.
   */
  async verify(): Promise<{ accountId: string; displayName: string; email: string | null }> {
    const me = await this.api<{ accountId: string; displayName: string; emailAddress?: string }>(
      '/myself',
    );
    return { accountId: me.accountId, displayName: me.displayName, email: me.emailAddress ?? null };
  }

  async listProjects(): Promise<JiraProject[]> {
    const page = await this.api<{ values: { id: string; key: string; name: string }[] }>(
      '/project/search?maxResults=100&orderBy=lastIssueUpdatedTime',
    );
    return (page.values ?? []).map((p) => ({ id: p.id, key: p.key, name: p.name }));
  }

  /**
   * Open issues in a project, newest first.
   *
   * Deliberately excludes Done — importing a closed backlog would fill the
   * board with work nobody is going to spec.
   */
  async listOpenIssues(projectKey: string, limit = 50): Promise<JiraIssue[]> {
    const jql = encodeURIComponent(`project = "${projectKey}" AND statusCategory != Done ORDER BY created DESC`);
    const page = await this.api<{ issues?: JiraIssueResponse[] }>(
      `/search?jql=${jql}&maxResults=${Math.min(limit, 100)}&fields=summary,description,status`,
    );
    return (page.issues ?? []).map((issue) => this.toIssue(issue));
  }

  async getIssue(key: string): Promise<JiraIssue> {
    const issue = await this.api<JiraIssueResponse>(
      `/issue/${encodeURIComponent(key)}?fields=summary,description,status`,
    );
    return this.toIssue(issue);
  }

  /**
   * Comment on an issue.
   *
   * v3 wants Atlassian Document Format, not a string — a plain-text body is
   * rejected outright. `adf()` builds the smallest valid document; nothing
   * outside this file needs to know that.
   */
  async addComment(issueKey: string, text: string): Promise<{ id: string }> {
    return this.api<{ id: string }>(`/issue/${encodeURIComponent(issueKey)}/comment`, {
      method: 'POST',
      body: JSON.stringify({ body: adf(text) }),
    });
  }

  async listTransitions(issueKey: string): Promise<JiraTransition[]> {
    const res = await this.api<{
      transitions?: { id: string; name: string; to?: { name?: string } }[];
    }>(`/issue/${encodeURIComponent(issueKey)}/transitions`);

    return (res.transitions ?? []).map((t) => ({
      id: t.id,
      name: t.name,
      to: t.to?.name ?? t.name,
    }));
  }

  /**
   * Move an issue to the named status, if a transition there is available.
   *
   * Resolves by *name* rather than id because ids are project-specific
   * integers nobody can configure by hand, and because a workflow's available
   * moves depend on where the issue currently sits — so this is a question
   * that can only be answered per issue, at call time.
   *
   * Returns `false` when no such transition is offered. That is a normal
   * outcome, not an error: Jira workflows have guards, and a spec reaching
   * `approved` does not oblige the issue to be movable.
   */
  async transitionTo(issueKey: string, statusName: string): Promise<boolean> {
    const wanted = statusName.trim().toLowerCase();
    const available = await this.listTransitions(issueKey);

    const match =
      available.find((t) => t.to.toLowerCase() === wanted) ??
      available.find((t) => t.name.toLowerCase() === wanted);
    if (!match) return false;

    await this.api(`/issue/${encodeURIComponent(issueKey)}/transitions`, {
      method: 'POST',
      body: JSON.stringify({ transition: { id: match.id } }),
    });
    return true;
  }

  browseUrl(issueKey: string): string {
    return `${this.siteUrl.replace(/\/+$/, '')}/browse/${issueKey}`;
  }

  private toIssue(issue: JiraIssueResponse): JiraIssue {
    return {
      key: issue.key,
      summary: issue.fields?.summary ?? '',
      description: plainText(issue.fields?.description),
      status: issue.fields?.status?.name ?? '',
      url: this.browseUrl(issue.key),
    };
  }
}

interface JiraIssueResponse {
  key: string;
  fields?: {
    summary?: string;
    description?: AdfNode | string | null;
    status?: { name?: string };
  };
}

interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
}

/** The smallest valid ADF document: one paragraph per line of text. */
export function adf(text: string): AdfNode {
  const paragraphs = text.split('\n').map((line) => ({
    type: 'paragraph',
    // ADF rejects an empty text node, so a blank line is an empty paragraph.
    content: line ? [{ type: 'text', text: line }] : [],
  }));

  return { type: 'doc', version: 1, content: paragraphs } as AdfNode & { version: number };
}

/**
 * Flatten an ADF description back to something a spec prompt can read.
 *
 * A ticket body is model input, so structure matters far less than not
 * feeding it a JSON blob. Older sites may still return a plain string, which
 * passes through untouched.
 */
export function plainText(node: AdfNode | string | null | undefined): string {
  if (!node) return '';
  if (typeof node === 'string') return node;

  const walk = (n: AdfNode): string => {
    if (n.type === 'text') return n.text ?? '';
    const inner = (n.content ?? []).map(walk).join('');
    // Block-level nodes become their own line; inline nodes concatenate.
    return n.type === 'paragraph' || n.type === 'heading' || n.type === 'listItem'
      ? `${inner}\n`
      : inner;
  };

  return walk(node).trim();
}

/** What a bare status code most likely means when Jira sends no body with it. */
function hintForStatus(status: number): string | null {
  switch (status) {
    case 401:
      return 'the email or API token was rejected — check both, and that the token has not been revoked';
    case 403:
      return 'that account is not allowed to do this on this site';
    case 404:
      return 'no such site, project or issue — check the site URL is your real Atlassian domain';
    case 429:
      return 'rate-limited by Atlassian; try again shortly';
    default:
      return status >= 500 ? 'Jira is having trouble on its side' : null;
  }
}

/** Jira reports failures in three different shapes depending on the endpoint. */
function describeJiraError(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      errorMessages?: string[];
      errors?: Record<string, string>;
      message?: string;
    };
    const messages = [
      ...(parsed.errorMessages ?? []),
      ...Object.values(parsed.errors ?? {}),
      ...(parsed.message ? [parsed.message] : []),
    ];
    return messages.join('; ').slice(0, 300);
  } catch {
    return body.slice(0, 300);
  }
}
