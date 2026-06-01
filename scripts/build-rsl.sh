#!/usr/bin/env bash
set -euo pipefail

# Build the vendored react-server-dom-esm transport that ships inside
# react-server-loader.
#
# react-server-dom-esm is not published to npm by the React team. This
# script clones React, runs React's own build pipeline, and copies the
# resulting transport into vendor/ so that the package's loader hooks can
# consume it at runtime.
#
# Usage:
#   ./scripts/build-rsl.sh [options]
#
# Options:
#   --channel <stable|experimental>   React release channel.
#                                     Default: experimental.
#   --react-ref <ref>                 Git ref (tag, branch, or commit) to
#                                     check out before building. Default:
#                                     main for experimental, "v19.0.0" for
#                                     stable.
#   --react-dir <path>                Existing React checkout to reuse.
#                                     Default: sibling ../react if present,
#                                     otherwise a shallow clone in
#                                     .tmp/react/.
#   --full                            Build every React package in the
#                                     selected channel (~15 min). Default
#                                     is the targeted react + react-dom +
#                                     react-server-dom-esm build (~2 min).
#   --skip-patches                    Don't apply scripts/patches/*.patch
#                                     to the built transport. Use when
#                                     building against a React version the
#                                     patches don't target.
#
# Prerequisites:
#   - yarn (React's repo uses yarn workspaces).
#   - Node.js 18+.
#   - java (for Google Closure Compiler, used by React's build).
#
# Output: vendor/react-server-dom-esm/ (cjs + esm), populated from the
# React build. The vendor/ directory is gitignored locally and included
# in the published npm tarball.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(dirname "$SCRIPT_DIR")"
PATCH_DIR="$SCRIPT_DIR/patches"
VENDOR_DIR="$PKG_DIR/vendor"

CHANNEL="experimental"
REACT_REF=""
REACT_DIR=""
FULL_BUILD=false
SKIP_PATCHES=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel) CHANNEL="$2"; shift 2 ;;
    --react-ref) REACT_REF="$2"; shift 2 ;;
    --react-dir) REACT_DIR="$2"; shift 2 ;;
    --full) FULL_BUILD=true; shift ;;
    --skip-patches) SKIP_PATCHES=true; shift ;;
    --help|-h)
      sed -n '/^# Usage:/,/^# Output:/p' "$0" | sed 's/^# //;s/^#//'
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

case "$CHANNEL" in
  stable|experimental) ;;
  *) echo "Invalid --channel '$CHANNEL'. Expected stable or experimental." >&2; exit 1 ;;
esac

if [[ -z "$REACT_REF" ]]; then
  if [[ "$CHANNEL" == "stable" ]]; then
    REACT_REF="v19.0.0"
  else
    REACT_REF="main"
  fi
fi

if [[ -z "$REACT_DIR" ]]; then
  if [[ -d "$(dirname "$PKG_DIR")/react" ]]; then
    REACT_DIR="$(dirname "$PKG_DIR")/react"
  else
    REACT_DIR="$PKG_DIR/.tmp/react"
  fi
fi

echo "Package dir:    $PKG_DIR"
echo "React dir:      $REACT_DIR"
echo "Channel:        $CHANNEL"
echo "React ref:      $REACT_REF"
echo "Full build:     $FULL_BUILD"
echo "Skip patches:   $SKIP_PATCHES"
echo ""

if [ ! -d "$REACT_DIR" ]; then
  echo "==> Cloning facebook/react (shallow, ref=$REACT_REF) into $REACT_DIR ..."
  mkdir -p "$(dirname "$REACT_DIR")"
  git clone --depth 1 --branch "$REACT_REF" https://github.com/facebook/react.git "$REACT_DIR" \
    || git clone --depth 1 https://github.com/facebook/react.git "$REACT_DIR"
else
  echo "==> Using existing React checkout at $REACT_DIR"
  echo "    Branch: $(cd "$REACT_DIR" && git branch --show-current 2>/dev/null || echo 'detached')"
  echo "    Commit: $(cd "$REACT_DIR" && git rev-parse --short HEAD)"
fi

if [[ "$REACT_REF" != "main" ]]; then
  (cd "$REACT_DIR" && git fetch --depth 1 origin "$REACT_REF" 2>/dev/null && git checkout "$REACT_REF" 2>/dev/null) \
    || echo "    (could not check out $REACT_REF — building against current HEAD)"
fi

echo ""
echo "==> Installing React's build dependencies (yarn) ..."
cd "$REACT_DIR"

if ! command -v yarn >/dev/null 2>&1; then
  echo "ERROR: yarn is required but not installed." >&2
  exit 1
fi

yarn install --frozen-lockfile 2>&1 | tail -5

echo ""
if [[ "$FULL_BUILD" == "true" ]]; then
  echo "==> Building the full $CHANNEL channel (~15 min) ..."
  RELEASE_CHANNEL="$CHANNEL" node scripts/rollup/build-all-release-channels.js \
    --releaseChannel "$CHANNEL" 2>&1 | tail -20
else
  echo "==> Building react + react-dom + react-server-dom-esm (targeted, ~2 min) ..."
  RELEASE_CHANNEL="$CHANNEL" node scripts/rollup/build.js \
    react react-dom react-server-dom-esm 2>&1 | tail -20

  echo ""
  echo "==> Running React's packaging step ..."
  RELEASE_CHANNEL="$CHANNEL" node scripts/rollup/build-all-release-channels.js \
    --releaseChannel "$CHANNEL" --unsafe-partial 2>&1 | tail -20 || true
fi

echo ""
echo "==> Copying packages into $VENDOR_DIR ..."

BUILD_BASE="$REACT_DIR/build/oss-$CHANNEL"
if [ ! -d "$BUILD_BASE" ]; then
  echo "ERROR: Build output not found at $BUILD_BASE" >&2
  echo "Try re-running with --full." >&2
  exit 1
fi

mkdir -p "$VENDOR_DIR"

for pkg in react-server-dom-esm react react-dom; do
  src="$BUILD_BASE/$pkg"
  if [ -d "$src" ]; then
    rm -rf "$VENDOR_DIR/$pkg"
    cp -r "$src" "$VENDOR_DIR/$pkg"
    echo "  ✓ $pkg"
  else
    echo "  ✗ $pkg (not in build output)"
  fi
done

if [[ "$FULL_BUILD" == "true" ]]; then
  for src in "$BUILD_BASE"/*/; do
    pkg_name=$(basename "$src")
    case "$pkg_name" in react|react-dom|react-server-dom-esm) continue ;; esac
    rm -rf "$VENDOR_DIR/$pkg_name"
    cp -r "$src" "$VENDOR_DIR/$pkg_name"
    echo "  ✓ $pkg_name"
  done
fi

if [[ "$SKIP_PATCHES" != "true" ]]; then
  echo ""
  echo "==> Applying patches from $PATCH_DIR ..."
  shopt -s nullglob
  applied=0
  for patch in "$PATCH_DIR"/*.patch; do
    [ -f "$patch" ] || continue
    pkg_name=$(basename "$patch" | sed -E 's/\+.*//')
    target="$VENDOR_DIR/$pkg_name"
    if [ -d "$target" ]; then
      (cd "$VENDOR_DIR" && patch -p2 --quiet -d "$pkg_name" < "$patch") && {
        echo "  ✓ $(basename "$patch")"
        applied=$((applied + 1))
      } || echo "  ✗ $(basename "$patch") (could not apply against $pkg_name)"
    fi
  done
  shopt -u nullglob
  [ "$applied" -gt 0 ] && echo "  Applied $applied patch(es)." || echo "  No patches applied."
fi

VERSION=$(python3 -c "import json; print(json.load(open('$VENDOR_DIR/react-server-dom-esm/package.json'))['version'])" 2>/dev/null || echo "unknown")

echo ""
echo "==> Done. react-server-dom-esm version: $VERSION"
echo "    Output:   $VENDOR_DIR/"
echo "    Channel:  $CHANNEL"
echo ""
echo "Suggested next step: update package.json version to match React, then publish."
