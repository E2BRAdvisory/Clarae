#!/usr/bin/env bash
# Publishes docs_html/ (task docs-build) as one commit on the gh-pages branch of a remote, for GitHub Pages (ADR-0067).
# The commit is built with a temporary index (no checkout, no worktree, no local branch) on top of the remote branch,
# which keeps its history; it is pushed as a fast-forward and skipped when the site did not change.
#
#   DOCS_REMOTE   remote to push to (default origin; a path or URL works too)
#   DOCS_BRANCH   branch of the site (default gh-pages)
#   DOCS_SITE     directory of the built site (default docs_html)
#   DOCS_DRY_RUN  1 builds the commit and prints it without pushing
#
# The commit's author is the git identity of whoever runs it (in GitHub Actions: github-actions[bot], set by docs.yml).
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
remote="${DOCS_REMOTE:-origin}"
branch="${DOCS_BRANCH:-gh-pages}"
site="${DOCS_SITE:-docs_html}"
dry_run="${DOCS_DRY_RUN:-0}"

if [ ! -f "$site/index.html" ] || [ ! -f "$site/.nojekyll" ]; then
  echo "docs-publish: $site/ is not a built site (index.html or .nojekyll missing): run task docs-build first" >&2
  exit 1
fi

source_rev="$(git rev-parse --short HEAD)"
if [ -n "$(git status --porcelain -- docs)" ]; then
  echo "docs-publish: warning: docs/ has uncommitted changes, the site does not match $source_rev" >&2
  source_rev="$source_rev-dirty"
fi

parent=""
if git ls-remote --exit-code --heads "$remote" "$branch" >/dev/null; then
  git fetch --quiet --no-tags "$remote" "refs/heads/$branch"
  parent="$(git rev-parse FETCH_HEAD)"
fi

git_dir="$(git rev-parse --absolute-git-dir)"
index="$(mktemp)"
trap 'rm -f "$index"' EXIT
rm -f "$index" # git wants a valid index file or none
# --force: the site's files are git-ignored in this repository (docs_html/ in .gitignore).
GIT_DIR="$git_dir" GIT_WORK_TREE="$PWD/$site" GIT_INDEX_FILE="$index" git -C "$site" add --all --force .
tree="$(GIT_INDEX_FILE="$index" git write-tree)"

if [ -n "$parent" ] && [ "$tree" = "$(git rev-parse "$parent^{tree}")" ]; then
  echo "docs-publish: $branch on $remote already has this site, nothing to publish"
  exit 0
fi

commit="$(git commit-tree "$tree" ${parent:+-p "$parent"} -m "docs: publish the documentation site from $source_rev")"

if [ "$dry_run" = 1 ]; then
  echo "docs-publish: dry run, $commit (tree $tree) not pushed to $remote $branch"
  exit 0
fi

git push --quiet "$remote" "$commit:refs/heads/$branch"
echo "docs-publish: $branch on $remote is now $commit (site from $source_rev)"
