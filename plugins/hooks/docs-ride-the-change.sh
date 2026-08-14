#!/bin/sh
# Stop — AGENTS.md rule 3: "Update knowledge/ IN THE SAME PR as the code it
# describes. Docs ride the change; they never trail it."
#
# The rule is the one most easily lost at the end of a long session, when the
# code works and stopping feels like finishing. This asks the question once, at
# the moment it is still cheap to answer: this spec branch changed code and
# touched nothing in knowledge/ — is that right?
#
# It asks ONCE. Claude Code sets stop_hook_active when a stop hook already
# fired, and this returns 0 on sight of it, so a considered "yes, nothing to
# document" ends the turn normally. This is a prompt, not a gate — the gate is
# gate.sh, and conflating the two would teach people to disable both.
set -u

input=$(cat 2>/dev/null || printf '')

# Already continuing from a stop hook: it has been asked, let it stop.
case "$input" in
  *'"stop_hook_active":true'* | *'"stop_hook_active": true'*) exit 0 ;;
esac

branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || exit 0
case "$branch" in
  spec/*) ;;
  *) exit 0 ;;
esac

# Compare against wherever this branch left the trunk. Ask the remote what its
# default branch is before guessing: a repo on master, develop or trunk would
# otherwise match none of the guesses and this hook would exit 0 forever
# without ever saying it had stopped working.
trunk=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)
base=''
for ref in "$trunk" origin/main main origin/master master; do
  [ -n "$ref" ] || continue
  base=$(git merge-base HEAD "$ref" 2>/dev/null) && [ -n "$base" ] && break
  base=''
done
# No trunk to compare against — nothing meaningful to say.
[ -n "$base" ] || exit 0

changed=$(
  git diff --name-only "$base" HEAD 2>/dev/null
  git diff --name-only 2>/dev/null
  git diff --cached --name-only 2>/dev/null
  # Untracked files count. A brand-new ADR or an as-built record is untracked
  # until someone runs `git add`, and that is the single most common way rule 3
  # gets satisfied — without this the hook nags precisely the person who did
  # write the document.
  git ls-files --others --exclude-standard 2>/dev/null
)
[ -n "$changed" ] || exit 0

# .specd-work/ is gitignored scratch (the pulled spec lands there), so a change
# to it is not the code this rule is about.
code_changed=$(printf '%s\n' "$changed" | grep -v '^knowledge/' | grep -v '^\.specd-work/' | head -n 1)
docs_changed=$(printf '%s\n' "$changed" | grep '^knowledge/' | head -n 1)

[ -n "$code_changed" ] || exit 0
[ -z "$docs_changed" ] || exit 0

cat >&2 <<EOF
specd: this spec branch changed code and nothing in knowledge/.

AGENTS.md rule 3 — docs ride the change; they never trail it. Before you
stop, check whether this work made a knowledge document wrong:

  - knowledge/architecture.md   if a module boundary or a flow moved
  - knowledge/conventions.md    if you established or broke a pattern
  - knowledge/specs/            the as-built record is the final task of
                                every spec (/specd:as-built)
  - a knowledge/decisions/ ADR  if you made a choice the next person
                                would otherwise have to re-litigate

If nothing needs updating, say so and stop again — this asks once.
EOF
exit 2
