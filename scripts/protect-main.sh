#!/usr/bin/env bash
# Branch protection for main, as one reproducible command.
#
# GitHub's free plan refuses rulesets on private repositories ("Upgrade to
# GitHub Pro or make this repository public") — so this cannot be applied
# until the repo flips public. It is committed here so that flip is followed
# by exactly one command, not by reconstructing the rules from memory:
#
#   ./scripts/protect-main.sh
#
# What it enforces on main:
#   - changes arrive by pull request (0 required approvals — solo-maintainer
#     reality: you cannot approve your own PR, and requiring one would wall
#     off every merge)
#   - the `verify` check must pass before merging — the gap that let #65
#     merge mid-CI closes here
#   - no force pushes, no branch deletion
#   - merge commits only, matching the repository's history
set -euo pipefail

repo="${1:-unitypark/specd}"

gh api "repos/${repo}/rulesets" -X POST --input - <<'JSON'
{
  "name": "main-protection",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false,
        "allowed_merge_methods": ["merge"]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [{ "context": "verify" }]
      }
    }
  ]
}
JSON

echo "main is protected: PRs only, verify required, no force pushes."
