#!/usr/bin/env bash
set -euo pipefail

# Build the vendored react-server-dom-esm transport that ships inside
# react-server-loader.
#
# react-server-dom-esm is not published to npm by the React team. This
# script clones React, runs React's own build pipeline to produce the
# transport, and copies the result into vendor/ so the package's loader
# hooks can consume it at runtime.
#
# Only react-server-dom-esm is vendored. React itself and react-dom come
# from the consumer's own install (the matching peer-dep range).
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
#
# Prerequisites:
#   - yarn (React's repo uses yarn workspaces).
#   - Node.js 18+.
#   - java (for Google Closure Compiler, used by React's build).
#
# Output: vendor/react-server-dom-esm/ — package.json from React's source
# plus the cjs/ and esm/ artifacts from the build. The vendor/ directory is
# gitignored locally and included in the published npm tarball.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(dirname "$SCRIPT_DIR")"
VENDOR_DIR="$PKG_DIR/vendor"

CHANNEL="experimental"
REACT_REF=""
REACT_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel) CHANNEL="$2"; shift 2 ;;
    --react-ref) REACT_REF="$2"; shift 2 ;;
    --react-dir) REACT_DIR="$2"; shift 2 ;;
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
echo "==> Building react-server-dom-esm (~2 min) ..."
# React's rollup build pulls transitive packages (react, scheduler,
# react-reconciler, etc.) into the graph even when only one package is
# requested. The downstream eslint-plugin-react-hooks TypeScript step can
# fail on a clean checkout; tolerate non-zero exits and rely on the copy
# step below to validate the artifacts actually landed.
set +o pipefail
RELEASE_CHANNEL="$CHANNEL" node scripts/rollup/build.js \
  react-server-dom-esm 2>&1 | tail -20 || true
set -o pipefail

ROLLUP_OUTPUT="$REACT_DIR/build/node_modules/react-server-dom-esm"
SRC_PKG_JSON="$REACT_DIR/packages/react-server-dom-esm/package.json"

if [ ! -d "$ROLLUP_OUTPUT" ]; then
  echo "ERROR: react-server-dom-esm build output not found at $ROLLUP_OUTPUT" >&2
  exit 1
fi
if [ ! -f "$SRC_PKG_JSON" ]; then
  echo "ERROR: react-server-dom-esm source package.json not found at $SRC_PKG_JSON" >&2
  exit 1
fi

echo ""
echo "==> Vendoring react-server-dom-esm into $VENDOR_DIR ..."
rm -rf "$VENDOR_DIR/react-server-dom-esm"
mkdir -p "$VENDOR_DIR/react-server-dom-esm"
cp -r "$ROLLUP_OUTPUT"/. "$VENDOR_DIR/react-server-dom-esm/"
cp "$SRC_PKG_JSON" "$VENDOR_DIR/react-server-dom-esm/package.json"

# React's source includes the shim entrypoints (index.js, client.js,
# client.browser.js, client.node.js, server.js, server.node.js,
# static.js, static.node.js) alongside the package.json. The rollup
# build produces only cjs/ and esm/; the shims are how consumers
# import the package (they re-export from cjs/ based on conditions).
PKG_SRC="$REACT_DIR/packages/react-server-dom-esm"
for shim in index.js client.js client.browser.js client.node.js \
            server.js server.node.js static.js static.node.js \
            LICENSE README.md; do
  [ -f "$PKG_SRC/$shim" ] && cp "$PKG_SRC/$shim" "$VENDOR_DIR/react-server-dom-esm/$shim"
done

VERSION=$(node -p "require('$VENDOR_DIR/react-server-dom-esm/package.json').version" 2>/dev/null || echo "unknown")

echo ""
echo "==> Done. react-server-dom-esm version: $VERSION"
echo "    Output:   $VENDOR_DIR/react-server-dom-esm/"
echo "    Channel:  $CHANNEL"
echo ""
echo "Next: update package.json version to match React, then publish."
