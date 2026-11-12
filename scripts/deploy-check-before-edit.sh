#!/usr/bin/env bash
# Claude Code PreToolUse hook (Edit|Write), once per session: before the first file change, check what
# the team has shipped or pushed (scripts/deploy-check.sh). New teammate branches are listed so the
# change can take them into account; a conflict blocks the edit (exit 2) until it is looked at.
dir="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -x "$dir/scripts/deploy-check.sh" ] || exit 0
out="$("$dir/scripts/deploy-check.sh" 2>&1)"
status=$?
summary="$(echo "$out" | grep -E '✓ origin/|✗|! |CONFLICT|deploy-check:' | head -25)"
if [ "$status" -ne 0 ]; then
  { echo "Deploy check before editing found problems:"; echo "$summary"; } >&2
  exit 2
fi
jq -n --arg s "$summary" '{hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: ("Deploy check before the first edit of this session (teammates'"'"' branches, site, contract):\n" + $s)}}'
