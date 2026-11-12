#!/usr/bin/env bash
# Deploy conflict check for the team. Run before every push to main, PR merge, site publish or
# contract deploy. Exit 0 = clear, 1 = a conflict or drift that someone has to look at.
#
# Checks:
#   1. Other branches and open PRs: do they merge cleanly into what you are about to ship, and which
#      files do both sides touch?
#   2. The public site (near-pilot-site, deployed by GitHub Pages from its own main): does it match
#      web/ on main, and was it edited directly (changes main does not have)?
#   3. The testnet NFT contract: is the deployed code the one recorded in scripts/deploy-state.env?
#
# Usage: scripts/deploy-check.sh [ref-to-ship]   (default: HEAD)
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
# shellcheck disable=SC1091
source "$ROOT/scripts/deploy-state.env"
SHIP="${1:-HEAD}"
GH="env -u GITHUB_TOKEN gh"
problems=0
warn() { echo "  ✗ $*"; problems=$((problems + 1)); }
ok() { echo "  ✓ $*"; }

[ -n "${DEPLOY_CHECK_NO_FETCH:-}" ] || git fetch -q --all --prune 2>/dev/null || warn "git fetch failed: the check may be stale"
ship_sha="$(git rev-parse "$SHIP")"
ship_files="$(git diff --name-only "$(git merge-base origin/main "$ship_sha")" "$ship_sha")"

echo "== 1. Branches and pull requests (shipping $(git rev-parse --short "$ship_sha"))"
others=0
for b in $(git branch -r --format='%(refname:short)' | grep -v -E '(^origin$|/HEAD$|^origin/main$)'); do
  [ "$(git rev-parse "$b")" = "$ship_sha" ] && continue
  ahead="$(git rev-list --count "origin/main..$b")"
  [ "$ahead" -eq 0 ] && continue
  others=$((others + 1))
  who="$(git log -1 --format='%an, %cr' "$b")"
  if git merge-tree --write-tree --quiet "$ship_sha" "$b" >/dev/null 2>&1; then
    overlap="$(comm -12 <(echo "$ship_files" | sort) <(git diff --name-only "$(git merge-base origin/main "$b")" "$b" | sort) | head -10)"
    if [ -n "$overlap" ]; then
      echo "  ! $b ($who): merges cleanly, but both sides change:"; echo "$overlap" | sed 's/^/      /'
    else
      ok "$b ($who): no overlap"
    fi
  else
    warn "$b ($who): CONFLICTS with what you ship:"
    git merge-tree --write-tree --name-only "$ship_sha" "$b" 2>/dev/null | sed -n '2,20p' | grep -v '^$' | sed 's/^/      /'
  fi
done
[ "$others" -eq 0 ] && ok "no other unmerged branches"
prs="$($GH pr list --repo "$REPO" --state open --json number,headRefName,author --jq '.[]|"#\(.number) \(.headRefName) by \(.author.login)"' 2>/dev/null)"
if [ -n "$prs" ]; then
  echo "  open PRs:"; echo "$prs" | sed 's/^/      /'
  while read -r num ref; do
    [ -z "$ref" ] && continue
    git rev-parse -q --verify "origin/$ref" >/dev/null || continue
    [ "$(git rev-list --count "origin/main..origin/$ref")" -eq 0 ] && echo "      (#$num is already in main: close it)"
  done <<< "$($GH pr list --repo "$REPO" --state open --json number,headRefName --jq '.[]|"\(.number) \(.headRefName)"' 2>/dev/null)"
fi

echo "== 2. Public site ($SITE_REPO)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
if $GH repo clone "$SITE_REPO" "$tmp/site" -- -q --depth 50 2>/dev/null; then
  git -C "$ROOT" archive "$ship_sha" web | tar -x -C "$tmp"
  diffs="$(diff -rq -x .git -x .github -x .nojekyll -x README.md "$tmp/web" "$tmp/site" 2>/dev/null | sed "s|$tmp/||g")"
  if [ -z "$diffs" ]; then
    ok "site matches web/ in what you ship"
  else
    echo "  ! site differs from web/ in what you ship:"; echo "$diffs" | head -15 | sed 's/^/      /'
    echo "      last site commit: $(git -C "$tmp/site" log -1 --format='%h %an %cr %s')"
    # A site file that equals some past version of web/<file> in main is only stale (fine, the next
    # publish updates it). One that matches no version of main was edited in the site repo directly.
    while IFS= read -r line; do
      case "$line" in
        "Files web/"*)
          f="${line#Files web/}"; f="${f%% and site/*}"
          blob="$(git hash-object "$tmp/site/$f")"
          known="$(git log --raw --no-abbrev --format= "$ship_sha" -- "web/$f")"
          if [[ "$known" == *"$blob"* ]]; then
            echo "      $f: an older version from main (stale, publishing fixes it)"
          else
            warn "site $f matches no version of web/$f in main: edited in $SITE_REPO directly, bring it into web/ first"
          fi ;;
        "Only in site"*) warn "${line}: exists only in the site repo, bring it into web/ first" ;;
        "Only in web"*) echo "      ${line}: not published yet" ;;
      esac
    done <<< "$diffs"
  fi
else
  warn "could not clone $SITE_REPO"
fi

echo "== 3. Testnet contract ($NFT_CONTRACT)"
code="$(curl -s -m 20 "$NFT_RPC" -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$NFT_CONTRACT\"}}" |
  python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["code_hash"])' 2>/dev/null)"
if [ -z "$code" ]; then
  warn "could not read the contract from $NFT_RPC"
elif [ "$code" = "$NFT_CODE_HASH" ]; then
  ok "deployed code is the recorded one ($code)"
else
  warn "deployed code $code differs from recorded $NFT_CODE_HASH: someone redeployed. Check with the team, then update scripts/deploy-state.env"
fi

echo
if [ "$problems" -eq 0 ]; then echo "deploy-check: clear"; exit 0; fi
echo "deploy-check: $problems problem(s): resolve them or agree with the team before shipping"
exit 1
