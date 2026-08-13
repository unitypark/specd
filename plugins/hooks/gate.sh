#!/bin/sh
# PreToolUse(Write|Edit) — the approval gate, enforced where the editing happens.
#
# AGENTS.md rule 5 says work arrives as approved specs. Today that rule is
# enforced at the server (the API refuses to serve an unapproved spec) and in
# CI (exit 3 blocks the build), but not in the editor — nothing stops an agent
# from opening spec/crm-1-widget and implementing a draft nobody approved.
# This closes that gap at the only moment it matters: the first write.
#
# Two disciplines, and the difference between them is the whole design:
#
#   fail OPEN on infrastructure — specd missing, not logged in, no project,
#     server unreachable, not a git repo, not a spec branch. A hook that
#     blocks every edit when the API is down is a hook people uninstall.
#
#   fail CLOSED on a verdict — exit 3 means the server positively said this
#     spec exists and is not approved. That is the one case we block.
#
# Exit 2 is the Claude Code contract for "block this tool call"; stderr is fed
# back to the agent, so the message below is written for it to act on.
set -u

# Not a git repo, or a detached HEAD with no branch name: nothing to check.
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || exit 0
[ -n "$branch" ] || exit 0

# Only spec/<id>-<slug> branches are spec work. Everything else — main, a
# throwaway experiment, a docs fix — this hook has no opinion about.
case "$branch" in
  spec/*) ;;
  *) exit 0 ;;
esac

# Recover the ticket key from the branch. Keys carry their own hyphen
# (CRM-1, S-104) and specBranchName() lowercases them, so spec/crm-1-add-widget
# means CRM-1 — the first two segments, when the second is numeric. Anything
# else, fall back to the first segment and let the server decide.
rest=${branch#spec/}
head=${rest%%-*}
tail=${rest#*-}
num=${tail%%-*}
case "$num" in
  '' | *[!0-9]*) id="$head" ;;
  *) id="$head-$num" ;;
esac
[ -n "$id" ] || exit 0

# Back to the canonical key. The server upper-cases a ref before it looks a
# ticket up, so either case resolves — but CRM-1 is what the board shows and
# what a human types, and the message below is read by someone about to go
# and find it.
id=$(printf '%s' "$id" | tr '[:lower:]' '[:upper:]')

command -v specd >/dev/null 2>&1 || exit 0

# `specd spec status` is an HTTP round trip and Write/Edit fire constantly, so
# cache the approved verdict briefly. Only the *allow* is cached: a block is
# re-checked every time, so approving a spec unblocks the next edit rather than
# leaving someone waiting out a TTL for work they were just cleared to do.
cache_dir="${TMPDIR:-/tmp}/specd-gate-$(id -u 2>/dev/null || echo 0)"
cache_key=$(printf '%s|%s' "$(git rev-parse --show-toplevel 2>/dev/null)" "$branch" |
  cksum | cut -d' ' -f1)
cache_file="$cache_dir/$cache_key"
if [ -n "${cache_key:-}" ] && find "$cache_file" -mmin -1 2>/dev/null | grep -q .; then
  exit 0
fi

specd spec status "$id" >/dev/null 2>&1
code=$?

if [ "$code" -eq 3 ]; then
  cat >&2 <<EOF
specd: $id is not approved, so this branch is not ready to implement.

The branch $branch says this is spec work, but the gate has not opened —
\`specd spec status $id\` returns exit 3 (the spec exists; a human has not
approved it). AGENTS.md rule 5: work items arrive as approved specs.

Stop implementing and tell the user. \`specd open $id\` opens the spec for
review. If this branch is not spec work after all, rename it off spec/.
EOF
  exit 2
fi

# Approved, or something we could not determine — either way, let the edit
# through. Only the positive verdict is worth remembering.
if [ "$code" -eq 0 ] && [ -n "${cache_key:-}" ]; then
  mkdir -p "$cache_dir" 2>/dev/null && : >"$cache_file" 2>/dev/null
fi
exit 0
