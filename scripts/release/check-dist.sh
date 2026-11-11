#!/bin/sh
# Fails when the front end of a release build has Milkdown or the end-to-end binding mock in it: the build of a
# release is the default one, whose Live mode is CodeMirror (ADR-0049, ADR-0050) and which talks to the real core.
# It reads the files that were built, so it also catches an import from editor/live/** that reached the entry by
# mistake, which the bundle budget would not (a lazy chunk counts only in the total, with a wide margin), and a stale
# dist/ made with MEMOBRAIN_E2E=1 that go:embed would pick up:
#
#   scripts/release/check-dist.sh <dist dir> [...]     apps/desktop/frontend/dist, web/dist
#
# It looks for "milkdown" (any case), "y-prosemirror" and "MilkdownAdapter" in every file of the folder, and for the
# markers of the mock, which survive minification: "installWailsMock" and "wails-mock" (the lazy chunk and its
# import) and "__mock" (the property it is published on, window.__mock), none of which is in a default build. The
# options are the ones POSIX grep and busybox both have. Plain POSIX sh: the cloud image runs it in a node:alpine stage
# (services/cloud/Dockerfile).
set -eu

[ $# -gt 0 ] || { echo "usage: $0 <dist dir> [...]" >&2; exit 2; }
for dir in "$@"; do
  [ -d "$dir" ] || { echo "error: $dir is not a directory: nothing to check" >&2; exit 1; }
  [ -n "$(ls -A "$dir")" ] || { echo "error: $dir is empty: nothing to check" >&2; exit 1; }
  hits="$(grep -rliE 'milkdown|y-prosemirror|MilkdownAdapter' "$dir" || true)"
  if [ -n "$hits" ]; then
    echo "error: Milkdown is in the release build $dir (built with MEMOBRAIN_LIVE_ENGINE, or imported from the default entry):" >&2
    printf '%s\n' "$hits" | head -n 10 >&2
    exit 1
  fi
  mocks="$(grep -rlE 'installWailsMock|wails-mock|__mock' "$dir" || true)"
  if [ -n "$mocks" ]; then
    echo "error: the end-to-end binding mock is in the release build $dir (built with MEMOBRAIN_E2E=1, or a stale dist/):" >&2
    printf '%s\n' "$mocks" | head -n 10 >&2
    exit 1
  fi
done
