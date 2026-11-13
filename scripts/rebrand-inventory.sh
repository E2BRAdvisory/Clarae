#!/usr/bin/env bash
# Lists where a product name appears by category (default: the former code name "nodus", to spot
# leftovers after the rebrand to Clarae notanda). Read-only: it never changes a file. Usage:
#   scripts/rebrand-inventory.sh            # counts per category
#   scripts/rebrand-inventory.sh --files    # also list the files of each category
#   scripts/rebrand-inventory.sh --name Foo # search another (case-insensitive) name
set -euo pipefail
cd "$(dirname "$0")/.."

NAME=nodus
FILES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --files) FILES=1 ;;
    --name) NAME="$2"; shift ;;
    -h | --help) sed -n '2,7p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

# git grep honours .gitignore and skips generated/vendor trees that are not tracked.
EXCLUDE=(':!yarn.lock' ':!go.work.sum' ':!**/go.sum' ':!.yarn' ':!**/wailsjs/**' ':!**/dist/**')

count() { # label, regex, pathspecs...
  local label="$1" re="$2"
  shift 2
  local out
  out=$(git grep --untracked --exclude-standard -IlEi -e "$re" -- "$@" "${EXCLUDE[@]}" 2>/dev/null || true)
  local n=0
  [ -n "$out" ] && n=$(printf '%s\n' "$out" | wc -l | tr -d ' ')
  local hits=0
  if [ -n "$out" ]; then
    hits=$(git grep --untracked --exclude-standard -IEi -c -e "$re" -- "$@" "${EXCLUDE[@]}" 2>/dev/null | awk -F: '{s+=$NF} END {print s+0}')
  fi
  printf '%-44s %5s files %6s lines\n' "$label" "$n" "$hits"
  if [ "$FILES" = 1 ] && [ -n "$out" ]; then printf '%s\n' "$out" | sed 's/^/      /'; fi
}

echo "Occurrences of \"$NAME\" (case-insensitive) in tracked files"
echo
echo "== User-visible strings"
count "UI strings (i18n json, both apps)" "$NAME" 'web/src/i18n/*.json' 'apps/desktop/frontend/src/i18n/*.json'
count "HTML titles / index pages"          "$NAME" 'web/index.html' 'apps/desktop/frontend/index.html'
count "Web UI source (not i18n)"           "$NAME" 'web/src/*.ts' 'web/src/*.tsx' 'web/public/*'
echo
echo "== Application identity"
count "Desktop app: build/ (project.json, config.yml, plists, installer: name, bundle id dev.nodus.desktop, protocols)" "$NAME" 'apps/desktop/build/*'
count "URL scheme nodus:// (code, config, docs)" "$NAME://" '*.go' '*.ts' '*.tsx' '*.json' '*.md' '*.yaml' '*.plist'
count "Desktop Go sources (incl. module path, app strings)" "$NAME" 'apps/desktop/main.go' 'apps/desktop/internal/*.go'
count "Environment variables NODUS_*"      "NODUS_[A-Z_]+" '*.go' '*.sh' '*.md' '*.yaml' '*.env' 'Taskfile.yml'
count "On-disk names: .nodus/ vault dir, data dir, keychain service" "\\.$NAME[/\"']|keychain|zalando|dataDir" 'apps/desktop/internal/*' 'shared/go/*'
count "Browser storage keys (nodus.web.*)" "$NAME\\.(web|e2e)" 'web/src/*' 'web/e2e/*'
echo
echo "== Packaging and deployment"
count "Cloud binary / cmd dir (nodus-cloud)" "$NAME-cloud" 'services/*' 'Taskfile.yml' 'scripts/*' 'deploy/*' '.github/*'
count "Docker (image, compose, env files)"   "$NAME" 'services/cloud/Dockerfile' 'deploy/docker/*'
count "Helm chart (name, templates, values)" "$NAME" 'deploy/helm/*'
count "k3d / dev scripts"                    "$NAME" 'deploy/k3d/*' 'scripts/*'
count "Keycloak realm, clients, audience"    "$NAME" 'deploy/keycloak/*'
count "Observability (metric prefix nodus_, dashboards, alerts)" "$NAME" 'deploy/observability/*' 'services/cloud/internal/observability/*'
count "GitHub workflows"                     "$NAME" '.github/*'
echo
echo "== Code identifiers"
count "Go module path nodus/..."             "(^|[^A-Za-z0-9_./-])$NAME/(apps|services|shared)" '*.go' 'go.mod' 'go.work' '*.yaml' '*.yml' '*.md' 'Taskfile.yml'
count "npm scope @nodus/*"                   "@$NAME/" 'package.json' '**/package.json' '*.ts' '*.tsx' '*.js' '*.json'
count "Protobuf package / OpenAPI"           "$NAME" 'api/*'
count "OIDC client ids / audience (nodus-desktop, nodus-web, nodus-api, nodus-admin-svc)" "$NAME-(desktop|web|api|admin)" '*.go' '*.ts' '*.tsx' '*.json' '*.yaml' '*.md' '*.env'
count "S3 bucket names (nodus-blobs, nodus-exports)" "$NAME-(blobs|exports)" '*.go' '*.yaml' '*.env' '*.md' '*.sh'
count "Realm roles (nodus-admin, nodus-user)" "$NAME-(admin|user)([^a-z]|$)" '*.go' '*.ts' '*.tsx' '*.json' '*.md'
echo
echo "== Documentation"
count "docs/ (Italian docs, ADR, QA)"       "$NAME" 'docs/*'
count "Root docs (CLAUDE.md, Specifications.md)" "$NAME" 'CLAUDE.md' 'Specifications.md' 'README*'
echo
echo "== Total"
count "Every tracked file"                  "$NAME" '.'
