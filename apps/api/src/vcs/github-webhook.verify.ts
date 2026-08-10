import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signature verification — the trust boundary for everything GitHub
 * tells us.
 *
 * The endpoint is unauthenticated by necessity: GitHub has no specd session.
 * The signature is therefore the *only* thing standing between a stranger and
 * "this PR merged, go re-index and mark the spec delivered". It is checked
 * before the payload is parsed, let alone acted on, and there is no
 * configuration that turns it off.
 */

export type SignatureFailure =
  | 'no-secret'
  | 'missing-signature'
  | 'malformed-signature'
  | 'mismatch'
  | 'empty-body';

export type VerifyResult = { ok: true } | { ok: false; reason: SignatureFailure };

/**
 * Verify `X-Hub-Signature-256` over the exact bytes GitHub sent.
 *
 * The raw buffer matters: re-serialising the parsed JSON changes key order and
 * whitespace, and the HMAC would never match again. Everything upstream of
 * this has to preserve the body byte-for-byte.
 */
export function verifySignature(
  rawBody: Buffer | undefined,
  signatureHeader: string | undefined,
  secret: string,
): VerifyResult {
  // An unset secret must fail closed. Treating "no secret" as "accept anything"
  // is how a forgotten env var turns into an open write endpoint.
  if (!secret) return { ok: false, reason: 'no-secret' };
  if (!rawBody || rawBody.length === 0) return { ok: false, reason: 'empty-body' };
  if (!signatureHeader) return { ok: false, reason: 'missing-signature' };

  const [algorithm, provided] = signatureHeader.split('=');
  if (algorithm !== 'sha256' || !provided || !/^[0-9a-f]+$/i.test(provided)) {
    return { ok: false, reason: 'malformed-signature' };
  }

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');

  // Compare as fixed-width buffers: timingSafeEqual throws on length mismatch,
  // and the length check itself must not leak through an early return.
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided.toLowerCase(), 'utf8');
  if (a.length !== b.length) return { ok: false, reason: 'mismatch' };

  return timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'mismatch' };
}

/** Sign a body the way GitHub does — used by the tests and the local replay tool. */
export function signBody(rawBody: Buffer | string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

// ─── payload shapes ──────────────────────────────────────────────────────────
// Only the fields specd reads. GitHub sends far more; narrowing here keeps the
// handlers honest about what they actually depend on.

export interface PullRequestEvent {
  action: string;
  pull_request?: {
    number: number;
    merged?: boolean;
    merge_commit_sha?: string | null;
    html_url?: string;
    head?: { ref?: string };
    base?: { ref?: string };
    user?: { login?: string };
    merged_by?: { login?: string } | null;
  };
  repository?: { full_name?: string; default_branch?: string };
  installation?: { id?: number };
}

export interface PushEvent {
  ref?: string;
  commits?: {
    id?: string;
    timestamp?: string;
    added?: string[];
    modified?: string[];
    removed?: string[];
  }[];
  head_commit?: {
    id?: string;
    timestamp?: string;
    added?: string[];
    modified?: string[];
    removed?: string[];
  } | null;
  repository?: { full_name?: string; default_branch?: string };
  installation?: { id?: number };
}

/** What the webhook decided to do, so the decision can be tested without a database. */
export type WebhookIntent =
  | { kind: 'ignore'; why: string }
  | { kind: 'setup-merged'; branch: string; prNumber: number; mergedBy: string | null }
  | { kind: 'spec-merged'; branch: string; prNumber: number; mergedBy: string | null }
  | { kind: 'reindex'; why: string; paths: string[] };

/**
 * Decide what a `pull_request` event means for us.
 *
 * A merged PR is the adoption signal (§6 step 6) — it is the difference
 * between "specd proposed something" and "the team took it". Anything else on
 * a pull request is somebody else's business.
 */
export function classifyPullRequest(
  event: PullRequestEvent,
  repo: { setupBranch: string | null },
  isSpecBranch: (branch: string) => boolean,
): WebhookIntent {
  if (event.action !== 'closed') {
    return { kind: 'ignore', why: `pull_request.${event.action} is not an adoption signal` };
  }

  const pr = event.pull_request;
  if (!pr) return { kind: 'ignore', why: 'pull_request payload had no pull_request' };

  // Closed-without-merge is a rejection. Nothing was adopted, so nothing moves.
  if (!pr.merged) {
    return { kind: 'ignore', why: `PR #${pr.number} was closed without merging` };
  }

  const branch = pr.head?.ref ?? '';
  if (!branch) return { kind: 'ignore', why: 'merged PR had no head branch' };

  const mergedBy = pr.merged_by?.login ?? null;

  if (repo.setupBranch && branch === repo.setupBranch) {
    return { kind: 'setup-merged', branch, prNumber: pr.number, mergedBy };
  }
  if (isSpecBranch(branch)) {
    return { kind: 'spec-merged', branch, prNumber: pr.number, mergedBy };
  }

  return { kind: 'ignore', why: `merged branch ${branch} is not a specd branch` };
}

/** Every path a push touched, across all commits in the event. */
export function pushedPaths(event: PushEvent): string[] {
  const paths = new Set<string>();
  for (const commit of event.commits ?? []) {
    for (const p of [...(commit.added ?? []), ...(commit.modified ?? []), ...(commit.removed ?? [])]) {
      paths.add(p);
    }
  }
  const head = event.head_commit;
  if (head) {
    for (const p of [...(head.added ?? []), ...(head.modified ?? []), ...(head.removed ?? [])]) {
      paths.add(p);
    }
  }
  return [...paths];
}

/**
 * Commits worth recording in the history ledger (0013).
 *
 * Deliberately not the same question as `classifyPush`. A push touching only
 * application code triggers no re-index and is exactly what drift is made of,
 * so it must be recorded even though nothing else happens because of it.
 *
 * Default branch only: coupling should describe what landed, not work on a
 * branch that may never merge. GitHub truncates `commits` on very large
 * pushes, which loses history rather than corrupting it — the ledger is a
 * lower bound on what happened, and treated as one.
 */
export function commitsFromPush(
  event: PushEvent,
  defaultBranch: string,
): { sha: string; at: Date; files: string[] }[] {
  if ((event.ref ?? '') !== `refs/heads/${defaultBranch}`) return [];

  const seen = new Set<string>();
  const out: { sha: string; at: Date; files: string[] }[] = [];

  for (const commit of [...(event.commits ?? []), ...(event.head_commit ? [event.head_commit] : [])]) {
    const sha = commit.id;
    if (!sha || seen.has(sha)) continue;
    const at = commit.timestamp ? new Date(commit.timestamp) : null;
    if (!at || Number.isNaN(at.getTime())) continue;
    seen.add(sha);
    out.push({
      sha,
      at,
      files: [...new Set([...(commit.added ?? []), ...(commit.modified ?? []), ...(commit.removed ?? [])])],
    });
  }
  return out;
}

/**
 * A push matters only when it changes `knowledge/` on the default branch —
 * that is the source of truth the index is derived from (D4). A push to a
 * feature branch changes nothing yet; a push that touches only application
 * code is the build's business, not the index's.
 */
export function classifyPush(event: PushEvent, defaultBranch: string): WebhookIntent {
  const ref = event.ref ?? '';
  if (ref !== `refs/heads/${defaultBranch}`) {
    return { kind: 'ignore', why: `push to ${ref || 'unknown ref'}, not the default branch` };
  }

  const knowledge = pushedPaths(event).filter((p) => p.startsWith('knowledge/'));
  if (knowledge.length === 0) {
    return { kind: 'ignore', why: 'push did not touch knowledge/' };
  }

  return {
    kind: 'reindex',
    why: `${knowledge.length} knowledge file(s) changed on ${defaultBranch}`,
    paths: knowledge,
  };
}
