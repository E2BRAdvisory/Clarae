#!/usr/bin/env bash
# Print the release notes of <version> (Markdown) to stdout (M7-WP3).
#
#   scripts/release/notes.sh <version> [previous-tag]
#
# Uses the "## <version>" (or "## [<version>]") section of CHANGELOG.md when the file exists;
# otherwise the list of commit subjects since the previous tag (or all commits when there is none).
set -euo pipefail
VERSION="${1:?usage: $0 <version> [previous-tag]}"; VERSION="${VERSION#v}"
PREV="${2:-}"
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [ -f CHANGELOG.md ]; then
  section="$(awk -v v="$VERSION" '
    /^## / { if (found) exit; h=$0; gsub(/^## \[?|\]?( .*)?$/, "", h); if (h == v) { found=1; next } }
    found { print }' CHANGELOG.md)"
  if [ -n "${section//[[:space:]]/}" ]; then printf '%s\n' "$section"; exit 0; fi
fi

echo "## Nodus $VERSION"
echo
if [ -n "$PREV" ]; then range="$PREV..HEAD"; else range="HEAD"; fi
git log --no-merges --pretty='- %s' "$range" | head -200
