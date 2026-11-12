#!/usr/bin/env bash
# Claude Code PreToolUse hook (Bash): runs scripts/deploy-check.sh before anything that ships —
# a push to main, a PR merge, a NEAR contract deploy, or a push to the site repo — and blocks the
# command (exit 2) when the check finds a conflict. Other commands pass through untouched.
cmd="$(jq -r '.tool_input.command // empty')"
ships='(gh[[:space:]].*pr[[:space:]]+merge|git[[:space:]].*push.*([[:space:]:]main([[:space:]]|$)|near-pilot-site)|near[[:space:]]+(contract[[:space:]]+)?deploy)'
[[ "$cmd" =~ $ships ]] || exit 0
dir="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -x "$dir/scripts/deploy-check.sh" ] || exit 0
if out="$("$dir/scripts/deploy-check.sh" 2>&1)"; then
  exit 0
fi
{
  echo "Deploy check failed: a teammate's branch, the site or the contract conflicts with this ship."
  echo "$out" | grep -E '✗|!|CONFLICT|deploy-check' | head -30
  echo "Resolve it or agree with the team, then retry."
} >&2
exit 2
