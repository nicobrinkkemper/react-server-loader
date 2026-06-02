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

# Always check out the requested ref — including `main` — and FAIL hard if we
# can't. Silently building the current HEAD would publish a transport from the
# wrong React (e.g. a stale tag), which for a release is unacceptable.
echo "==> Checking out React ref '$REACT_REF' ..."
(
  cd "$REACT_DIR"
  git fetch --depth 1 origin "$REACT_REF" 2>/dev/null || true
  git checkout "$REACT_REF" 2>/dev/null \
    || git checkout "origin/$REACT_REF" 2>/dev/null \
    || git checkout FETCH_HEAD 2>/dev/null
) || {
  echo "ERROR: could not check out React ref '$REACT_REF' in $REACT_DIR." >&2
  echo "       Fetch it first (cd $REACT_DIR && git fetch origin $REACT_REF)" >&2
  echo "       or pass --react-ref <an available tag/branch/sha>." >&2
  exit 1
}
echo "    React now at: $(cd "$REACT_DIR" && git rev-parse --short HEAD) ($(cd "$REACT_DIR" && git describe --tags --always 2>/dev/null))"

echo ""
echo "==> Installing React's build dependencies (yarn) ..."
cd "$REACT_DIR"

if ! command -v yarn >/dev/null 2>&1; then
  echo "ERROR: yarn is required but not installed." >&2
  exit 1
fi

yarn install --frozen-lockfile 2>&1 | tail -5

ROLLUP_OUTPUT="$REACT_DIR/build/node_modules/react-server-dom-esm"
SRC_PKG_JSON="$REACT_DIR/packages/react-server-dom-esm/package.json"

echo ""
echo "==> Building react-server-dom-esm (~2 min) ..."
# React's rollup build pulls transitive packages (react, scheduler,
# react-reconciler, etc.) into the graph even when only one package is
# requested. The downstream eslint-plugin-react-hooks TypeScript step can
# fail on a clean checkout; tolerate non-zero exits and rely on the output
# check below to validate the artifacts actually landed.
#
# React's build is also occasionally flaky — its prettier/Flow formatting step
# can crash mid-run and produce no output. That's transient: a clean retry
# succeeds. So retry a few times (wiping any partial output first) rather than
# failing the whole release on a flake.
BUILD_OK=false
for attempt in 1 2 3; do
  [ "$attempt" -gt 1 ] && echo "    React build produced no output (attempt $((attempt - 1))) — retrying ..."
  rm -rf "$ROLLUP_OUTPUT"
  set +o pipefail
  RELEASE_CHANNEL="$CHANNEL" node scripts/rollup/build.js \
    react-server-dom-esm 2>&1 | tail -20 || true
  set -o pipefail
  if [ -d "$ROLLUP_OUTPUT" ]; then BUILD_OK=true; break; fi
done

if [ "$BUILD_OK" != "true" ]; then
  echo "ERROR: react-server-dom-esm build output not found at $ROLLUP_OUTPUT" >&2
  echo "       React's rollup build failed 3 times. Re-run, or build it by hand:" >&2
  echo "       (cd $REACT_DIR && RELEASE_CHANNEL=$CHANNEL node scripts/rollup/build.js react-server-dom-esm)" >&2
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

# React's source includes flow-typed shim files alongside the
# package.json (index.js, client.js, server.node.js, …). Those source
# shims aren't directly loadable in Node — they're an ESM/@flow shape
# rewritten by React's packaging step into the conditional-require
# shape consumers actually import. Generate the publishable shims
# here instead of running React's full packaging step (which fails
# on unrelated downstream packages on a clean checkout).
PKG_SRC="$REACT_DIR/packages/react-server-dom-esm"
for f in LICENSE README.md; do
  [ -f "$PKG_SRC/$f" ] && cp "$PKG_SRC/$f" "$VENDOR_DIR/react-server-dom-esm/$f"
done
node "$SCRIPT_DIR/generate-shims.mjs"

REACT_VERSION=$(node -p "require('$VENDOR_DIR/react-server-dom-esm/package.json').version" 2>/dev/null || echo "unknown")

echo ""
echo "==> Stamping react-server-loader/package.json for channel '$CHANNEL' ..."
# rsl's version === the vendored react-server-dom-esm version, because the
# transport is hard-bound to one React build's internals (it reads React's
# `ReactSharedInternals`). The version is therefore the unambiguous signal of
# *which React's internals* this transport expects — so it must match the
# transport/React exactly, and the peer must keep consumers on a compatible
# React. The build stamps both onto rsl's own package.json (single source of
# truth); the vendored transport's package.json is left as React shipped it.
#
# This mirrors React's own published transports
# (react-server-dom-webpack / -parcel):
#   stable       -> version = <ReactVersion> (e.g. 19.2.7), peer "^<ReactVersion>".
#                   React keeps the RSC ABI stable within a major, so ^ floors
#                   at the vendored build and is safe up to the next major.
#   experimental -> version = 0.0.0-experimental-<sha>-<date>, peer = that EXACT
#                   string. Internals change per commit, so the peer must be
#                   exact — a wider range would let a consumer pair this
#                   transport with a different experimental React and crash on
#                   the ReactSharedInternals/"older version of React" mismatch.
#                   sha  = `git rev-parse HEAD`, first 8 chars
#                   date = committer date YYYYMMDD in the commit's own tz (matches
#                          facebook/react build-all-release-channels.js, NOT UTC)
#                   Patch by republishing with a trailing `.N`.
#
# We are still cd'd into the React checkout here, so git reads its HEAD.
RSL_SHA=$(git rev-parse HEAD | cut -c1-8)
RSL_DATE=$(git show -s --no-show-signature --format=%cd --date=format:%Y%m%d "$RSL_SHA")
RSL_DATE=${RSL_DATE#\'}            # strip CI quote-wrapping ('...' )
RSL_DATE=${RSL_DATE%\'}
RSL_CHANNEL="$CHANNEL" RSL_SHA="$RSL_SHA" RSL_DATE="$RSL_DATE" \
  RSL_REACT="$REACT_VERSION" RSL_OWN_PKG="$PKG_DIR/package.json" \
  RSL_VENDOR_PKG="$VENDOR_DIR/react-server-dom-esm/package.json" node -e '
  const fs = require("fs");
  const { RSL_OWN_PKG, RSL_VENDOR_PKG, RSL_CHANNEL, RSL_SHA, RSL_DATE, RSL_REACT } = process.env;
  const pkg = JSON.parse(fs.readFileSync(RSL_OWN_PKG, "utf8"));   // rsl itself
  const reactFull = RSL_REACT;                                    // vendored React in-repo version, e.g. 19.2.7
  let peer;
  if (RSL_CHANNEL === "experimental") {
    pkg.version = `0.0.0-experimental-${RSL_SHA}-${RSL_DATE}`;    // synthesized (React publish convention)
    peer = pkg.version;                                           // EXACT pin (internals per-sha)
  } else {
    pkg.version = reactFull;                                      // === transport/React version
    peer = `^${reactFull}`;                                       // React stable transport convention
  }
  pkg.peerDependencies = { ...pkg.peerDependencies, react: peer, "react-dom": peer };
  fs.writeFileSync(RSL_OWN_PKG, JSON.stringify(pkg, null, 2) + "\n");
  // Keep the vendored transport package.json version in lockstep with rsl, so
  // the two are consistent (and the publish guard can assert version === vendor).
  // For stable this is a no-op (both = React version); for experimental it sets
  // the transport to the same 0.0.0-experimental-<sha> string.
  const vpkg = JSON.parse(fs.readFileSync(RSL_VENDOR_PKG, "utf8"));
  vpkg.version = pkg.version;
  fs.writeFileSync(RSL_VENDOR_PKG, JSON.stringify(vpkg, null, 2) + "\n");
  console.log(`stamped react-server-loader: version=${pkg.version} peer.react=${peer}`);
'

VERSION=$(node -p "require('$PKG_DIR/package.json').version" 2>/dev/null || echo "unknown")

echo ""
echo "==> Done. Vendored react-server-dom-esm: $REACT_VERSION (channel $CHANNEL)"
echo "    react-server-loader will publish as: $VERSION  (=== transport version)"
echo "    Output: $VENDOR_DIR/react-server-dom-esm/"
echo ""
echo "package.json now carries the publish-ready version + peer. Next:"
echo "  npm run verify   # gate against a real consumer"
echo "  npm pack && npm publish <tgz> --tag $([ "$CHANNEL" = experimental ] && echo experimental || echo latest)"
echo "  (build-rsl.sh sets package.json's version to the transport's; for a"
echo "   throwaway local build, git checkout package.json afterwards.)"
