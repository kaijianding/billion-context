#!/usr/bin/env bash
# Re-apply the google-native-intercept fix to a fresh billion-context checkout.
#
# Upstream released a new version? Rebase and re-apply:
#   1. cd <billion-context clone> && git fetch origin && git checkout <new-tag>
#   2. ./scripts/apply-google-intercept-patch.sh   # (from repo root)
#   3. npm run build   # dist/ now carries the fix
#   4. deploy dist/ per your setup (omp loads dist/agent/omp-native.js)
#
# The fix lives on branch fix-google-intercept (base v0.1.204). This script
# exports the diff and applies it with --3way so it tolerates small upstream
# drift. If git cannot merge cleanly, resolve the conflict manually and
# continue with `npm run build`.

set -euo pipefail
cd "$(dirname "$0")/.."

PATCH_BRANCH="fix-google-intercept"
PATCH_BASE="v0.1.204"

if ! git rev-parse --verify -q "$PATCH_BRANCH" >/dev/null; then
    echo "branch $PATCH_BRANCH missing; creating from $PATCH_BASE" >&2
    git fetch origin "$PATCH_BRANCH" 2>/dev/null || true
    git branch "$PATCH_BRANCH" "$PATCH_BASE" 2>/dev/null || true
fi

echo "exporting fix from $PATCH_BRANCH (base $PATCH_BASE)…"
git format-patch "$PATCH_BASE..$PATCH_BRANCH" -o patches/ >/dev/null

for pf in patches/000*.patch; do
    echo "applying $pf (--3way)…"
    git apply --3way "$pf"
done
echo "OK — patches applied. Rebuild: npm run build"
