#!/usr/bin/env bash
# Builds the Strudel REPL that DJ Opus serves from a pinned upstream commit plus the patches in patches/strudel/,
# and puts it in static/:
#
#   npm run build:strudel
#
# 1. Clones https://codeberg.org/uzu/strudel.git into .strudel-build/ (once), checks the pinned commit out there,
#    throws away what an earlier build left (node_modules aside, so a reinstall stays quick), and applies the patches
#    in order. It stops at the first one that does not apply.
# 2. Runs Strudel's own `pnpm install --frozen-lockfile` and `pnpm run build`. The site lands in
#    .strudel-build/website/dist.
# 3. Makes static/ equal that site, then lays this repo's own files over it: client/strudel-ws-bridge.js and
#    client/_headers (tracked in static/, so kept out of the rsync), and djopus-build.json, the record of what was
#    built: the Strudel commit, a hash per patch, the pnpm and node versions, and when.
#
# scripts/check-static.mjs refuses a deploy of a static/ that this script did not finish. Strudel is AGPL-3.0: the
# commit below plus patches/strudel/ are the source of the modified build the app serves.
set -euo pipefail

# The git commands below clone, check out, `reset --hard` and `clean -fdx`, so they must never run in a repository the
# caller's environment picked. Git exports GIT_INDEX_FILE to a pre-commit hook, and GIT_DIR as well in a linked worktree;
# with those set, git works on that repository's index and files wherever it is started, and `git -C` does not help.
# Clear every variable git keeps for the repository it works on.
# shellcheck disable=SC2046  # splitting the list of names is the point
unset $(git rev-parse --local-env-vars)

STRUDEL_URL="https://codeberg.org/uzu/strudel.git"
# A merge on main from 2026-03-15.
STRUDEL_COMMIT="9f19e4616a358ad31032e0f9af82060d23bc0d70"
# The pnpm that builds it is pnpm 10, exactly this version, whatever pnpm is installed here (npx keeps the version in its
# cache, so a run that has it needs no network to find it). The lockfile of that commit is lockfileVersion 9.0 (pnpm 9
# and 10 write it), and its pnpm-workspace.yaml lists the dependencies allowed to run build scripts as
# `onlyBuiltDependencies`, which pnpm 10 reads. pnpm 12 reads the lockfile but ignores that list, and then fails the
# install on those scripts (ERR_PNPM_IGNORED_BUILDS). npx fetches pnpm into its own cache: nothing is installed globally.
PNPM=(npx --yes pnpm@10.34.9)

# CDPATH is emptied for this cd: with it set, `cd scripts/..` can search CDPATH first and print the directory it went to.
# /bin/pwd, not the builtin: on a case-insensitive volume the builtin's -P keeps the case the path was typed in, and git (which the
# guard below compares with) reports the case the directory is stored with.
CLOUDFLARE_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && /bin/pwd -P)"
BUILD_DIR="$CLOUDFLARE_DIR/.strudel-build"
DIST_DIR="$BUILD_DIR/website/dist"
PATCH_DIR="$CLOUDFLARE_DIR/patches/strudel"
CLIENT_DIR="$CLOUDFLARE_DIR/client"
STATIC_DIR="$CLOUDFLARE_DIR/static"

say() { echo "build-strudel: $*"; }
die() { echo "build-strudel: $*" >&2; exit 1; }

for tool in git node npx rsync; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is not on the PATH, and the build needs it"
done

# Asked now, before anything is cloned or replaced: a pnpm that cannot run stops the build here. The version goes into
# djopus-build.json.
PNPM_VERSION="$("${PNPM[@]}" --version)" || die "could not run ${PNPM[*]} --version, and the build needs pnpm"

# bash 3.2 (macOS) has no mapfile, and an empty array trips set -u there, so the patches are listed with a glob and
# counted before anything is built.
shopt -s nullglob
patches=("$PATCH_DIR"/*.patch)
shopt -u nullglob
[ "${#patches[@]}" -gt 0 ] || die "there are no patches in $PATCH_DIR"
# Checked now, not after the build has replaced static/: these two are copied into it.
for file in strudel-ws-bridge.js _headers; do
  [ -f "$CLIENT_DIR/$file" ] || die "client/$file is missing, and the build copies it into static/"
done

# `reset --hard` and `clean -fdx` below throw work away. Make sure they run in a clone that is this script's own and nowhere
# else: not in the repository this directory sits in (where git would land if .strudel-build had no .git of its own), and
# not in whatever a symbolic link points at (a link to another checkout would lose that checkout's changes).
[ ! -L "$BUILD_DIR" ] ||
  die ".strudel-build is a symbolic link, and the build discards changes in its clone; remove the link and run this again"
# The same goes for static/: rsync --delete below follows a link there and replaces whatever it points to.
[ ! -L "$STATIC_DIR" ] ||
  die "static is a symbolic link, and the build replaces everything in it; remove the link and run this again"

if [ ! -e "$BUILD_DIR" ]; then
  say "cloning $STRUDEL_URL into .strudel-build"
  git clone --quiet "$STRUDEL_URL" "$BUILD_DIR"
fi

# BUILD_DIR is a physical path (CLOUDFLARE_DIR comes from /bin/pwd -P, and the link check above rules out a link in the last
# place), and git reports the top level and the git directory of a repository as physical paths. A directory that is not a
# repository of its own is reported as the repository around it, and a file or a directory that cannot be read as nothing:
# neither equals BUILD_DIR. The work tree is not enough, though: a .git that is a link, or a gitfile, leaves the work tree here
# and puts the repository (its HEAD and index) somewhere else. So .git must be a real directory, and be where git says it is.
if [ "$(git -C "$BUILD_DIR" rev-parse --show-toplevel 2>/dev/null || true)" != "$BUILD_DIR" ] ||
  [ -L "$BUILD_DIR/.git" ] || [ ! -d "$BUILD_DIR/.git" ] ||
  [ "$(git -C "$BUILD_DIR" rev-parse --absolute-git-dir 2>/dev/null || true)" != "$BUILD_DIR/.git" ]; then
  die ".strudel-build is not a git clone of Strudel of its own; delete it and run this again"
fi

# The commit is immutable, so a clone that has it needs no network to build.
if ! git -C "$BUILD_DIR" cat-file -e "$STRUDEL_COMMIT^{commit}" 2>/dev/null; then
  say "fetching $STRUDEL_URL"
  git -C "$BUILD_DIR" fetch --quiet origin
  git -C "$BUILD_DIR" cat-file -e "$STRUDEL_COMMIT^{commit}" 2>/dev/null ||
    die "commit $STRUDEL_COMMIT is not in $STRUDEL_URL"
fi

say "checking out $STRUDEL_COMMIT"
git -C "$BUILD_DIR" checkout --quiet --force --detach "$STRUDEL_COMMIT"
git -C "$BUILD_DIR" reset --quiet --hard
git -C "$BUILD_DIR" clean --quiet -fdx -e node_modules

for patch in "${patches[@]}"; do
  say "applying $(basename "$patch")"
  git -C "$BUILD_DIR" apply "$patch" || die "$(basename "$patch") does not apply to $STRUDEL_COMMIT"
done

say "installing Strudel's dependencies (pnpm $PNPM_VERSION: install --frozen-lockfile)"
# .strudel-build belongs to this script, so a node_modules that another pnpm made is replaced without asking: pnpm would
# ask first, and stops when there is no terminal.
# The install ends with a warning, "Ignored build scripts: @serialport/bindings-cpp". It comes from upstream's own
# onlyBuiltDependencies list, which leaves that package out, and the website build does not need it: it is expected.
(cd "$BUILD_DIR" && "${PNPM[@]}" install --frozen-lockfile --config.confirmModulesPurge=false)
say "building Strudel (pnpm run build)"
(cd "$BUILD_DIR" && "${PNPM[@]}" run build)
[ -f "$DIST_DIR/index.html" ] || die "the build left no index.html in $DIST_DIR"

say "replacing static/ with the build"
mkdir -p "$STATIC_DIR"
# The manifest goes first, so that a build that stops half way leaves a static/ without one, and check-static refuses it.
rm -f "$STATIC_DIR/djopus-build.json"
# _headers and strudel-ws-bridge.js are tracked files of this repo. Excluded, rsync neither overwrites nor deletes them,
# so a build that fails never leaves either missing. They are refreshed from client/ right after.
rsync -a --delete --exclude '/_headers' --exclude '/strudel-ws-bridge.js' "$DIST_DIR/" "$STATIC_DIR/"
cp "$CLIENT_DIR/strudel-ws-bridge.js" "$CLIENT_DIR/_headers" "$STATIC_DIR/"

# Built in a variable, so that a failing node leaves no half-written manifest behind.
build_info="$(node -e '
  const { createHash } = require("node:crypto");
  const { readFileSync } = require("node:fs");
  const { basename } = require("node:path");
  const [strudelCommit, pnpm, ...files] = process.argv.slice(1);
  const patches = files.map((file) => ({
    file: basename(file),
    sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
  }));
  const manifest = { strudelCommit, patches, pnpm, node: process.version, builtAt: new Date().toISOString() };
  console.log(JSON.stringify(manifest, null, 2));
' "$STRUDEL_COMMIT" "$PNPM_VERSION" "${patches[@]}")"
printf '%s\n' "$build_info" > "$STATIC_DIR/djopus-build.json"

say "done: static/ holds Strudel $STRUDEL_COMMIT with ${#patches[@]} patches (djopus-build.json)"
