#!/bin/sh
# Fails when the front end of a release build has the collaboration code (Yjs, y-prosemirror) or the end-to-end
# binding mock in it, or has no Milkdown Live editor: the build of a release is the default one, whose Live mode is
# Milkdown (ADR-0049) without collaboration (ADR-0050), and which talks to the real core. It reads the files that were
# built, so it also catches an import of editor/live/chunks/collab that reached the build by mistake (a stub stands in
# for it unless CLARAE_COLLAB=1), a stale dist/ made with CLARAE_E2E=1 that go:embed would pick up, and a build
# whose Live editor chunk is gone:
#
#   scripts/release/check-dist.sh <dist dir> [...]     apps/desktop/frontend/dist, web/dist
#
# It looks for the markers of the collaboration code that survive minification (the package names do not: the
# comments that carry them are dropped): "Yjs was already imported" (the warning of yjs), "y-sync" (the plugin key
# of y-prosemirror) and "ProseMirror-yjs-cursor" (its class), none of which is in a default build; and for the
# markers of the mock, which survive minification too: "installWailsMock" and "wails-mock" (the lazy chunk and its import) and "__mock" (the property it is
# published on, window.__mock), none of which is in a default build. It also wants the chunk of the Live editor,
# assets/MilkdownEditor-<hash>.js: without it a note would open in Live as Source, with a notice. The options are the
# ones POSIX grep and busybox both have. Plain POSIX sh: the cloud image runs it in a node:alpine stage
# (services/cloud/Dockerfile).
set -eu

[ $# -gt 0 ] || { echo "usage: $0 <dist dir> [...]" >&2; exit 2; }
for dir in "$@"; do
  [ -d "$dir" ] || { echo "error: $dir is not a directory: nothing to check" >&2; exit 1; }
  [ -n "$(ls -A "$dir")" ] || { echo "error: $dir is empty: nothing to check" >&2; exit 1; }
  hits="$(grep -rlE 'Yjs was already imported|"y-sync"|ProseMirror-yjs-cursor' "$dir" || true)"
  if [ -n "$hits" ]; then
    echo "error: the collaboration code (Yjs, y-prosemirror) is in the release build $dir (built with CLARAE_COLLAB, or imported past the stub of live/chunks/collab):" >&2
    printf '%s\n' "$hits" | head -n 10 >&2
    exit 1
  fi
  if [ -z "$(find "$dir" -name 'MilkdownEditor-*.js' | head -n 1)" ]; then
    echo "error: the Milkdown Live editor (assets/MilkdownEditor-*.js) is not in the build $dir: the Live mode would show every note as Source" >&2
    exit 1
  fi
  mocks="$(grep -rlE 'installWailsMock|wails-mock|__mock' "$dir" || true)"
  if [ -n "$mocks" ]; then
    echo "error: the end-to-end binding mock is in the release build $dir (built with CLARAE_E2E=1, or a stale dist/):" >&2
    printf '%s\n' "$mocks" | head -n 10 >&2
    exit 1
  fi
done
