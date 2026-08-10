import { timingSafeEqual } from 'node:crypto';
import type { WebhookIntent } from './github-webhook.verify.js';

/**
 * Webhook trust boundary for GitLab — the same purpose as
 * `github-webhook.verify.ts`, a different mechanism. GitLab does not sign the
 * payload: a webhook is created with a **secret token**, and GitLab echoes it
 * back verbatim on every delivery in `X-Gitlab-Token`. Verifying it is
 * therefore a direct comparison rather than an HMAC recomputation — but the
 * stakes are identical, so is the constant-time compare, and so is failing
 * closed when no secret is configured.
 *
 * Push events carry the exact same `commits[].{added,modified,removed}` shape
 * GitHub sends, so `classifyPush`/`pushedPaths` are reused unchanged rather
 * than re-implemented — this is the one shape GitLab and GitHub genuinely
 * share; merge requests are not, and get their own classifier below.
 */
export { classifyPush, pushedPaths } from './github-webhook.verify.js';
export type { PushEvent, WebhookIntent } from './github-webhook.verify.js';
// GitLab's push hook carries the same commits[].{id,timestamp,added,modified,
// removed} shape, so the ledger extractor is shared rather than duplicated.
export { commitsFromPush } from './github-webhook.verify.js';

export type TokenFailure = 'no-secret' | 'missing-token' | 'mismatch';
export type VerifyResult = { ok: true } | { ok: false; reason: TokenFailure };

/**
 * Verify `X-Gitlab-Token` against the secret this project's webhook was
 * registered with. Unlike GitHub's signature, this does not cover the body —
 * GitLab does not sign payloads — so the token is the whole trust boundary.
 */
export function verifyToken(headerValue: string | undefined, secret: string): VerifyResult {
  // An unset secret must fail closed, exactly as it does for GitHub: "no
  // secret" must never mean "accept anything".
  if (!secret) return { ok: false, reason: 'no-secret' };
  if (!headerValue) return { ok: false, reason: 'missing-token' };

  const a = Buffer.from(headerValue, 'utf8');
  const b = Buffer.from(secret, 'utf8');
  // timingSafeEqual throws on a length mismatch, and the length check itself
  // must not leak through an early, faster return.
  if (a.length !== b.length) return { ok: false, reason: 'mismatch' };

  return timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'mismatch' };
}

// ─── payload shapes ──────────────────────────────────────────────────────────
// Only the fields specd reads. GitLab sends far more; narrowing here keeps the
// handlers honest about what they actually depend on.

export interface MergeRequestEvent {
  object_kind?: string;
  object_attributes?: {
    iid: number;
    action?: string;
    state?: string;
    source_branch?: string;
    target_branch?: string;
    url?: string;
  };
  project?: { path_with_namespace?: string; default_branch?: string; id?: number; web_url?: string };
  user?: { username?: string; name?: string };
}

/**
 * Decide what a `merge_request` event means for us.
 *
 * GitLab tells merges and rejections apart with a dedicated `action: "merge"`
 * — there is no GitHub-style overload of "closed" that needs a second field
 * to disambiguate. Anything else on a merge request is somebody else's
 * business, the same rule the GitHub classifier applies to pull requests.
 */
export function classifyMergeRequest(
  event: MergeRequestEvent,
  repo: { setupBranch: string | null },
  isSpecBranch: (branch: string) => boolean,
): WebhookIntent {
  const attrs = event.object_attributes;
  if (!attrs) return { kind: 'ignore', why: 'merge_request payload had no object_attributes' };

  if (attrs.action !== 'merge' || attrs.state !== 'merged') {
    return {
      kind: 'ignore',
      why:
        attrs.action === 'close'
          ? `MR !${attrs.iid} was closed without merging`
          : `merge_request.${attrs.action ?? 'unknown'} is not an adoption signal`,
    };
  }

  const branch = attrs.source_branch ?? '';
  if (!branch) return { kind: 'ignore', why: 'merged MR had no source branch' };

  const mergedBy = event.user?.username ?? null;

  if (repo.setupBranch && branch === repo.setupBranch) {
    return { kind: 'setup-merged', branch, prNumber: attrs.iid, mergedBy };
  }
  if (isSpecBranch(branch)) {
    return { kind: 'spec-merged', branch, prNumber: attrs.iid, mergedBy };
  }

  return { kind: 'ignore', why: `merged branch ${branch} is not a specd branch` };
}
