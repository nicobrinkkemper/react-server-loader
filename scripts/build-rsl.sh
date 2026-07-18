#!/usr/bin/env bash
set -euo pipefail

# Build the vendored RSC transports that ship inside react-server-loader:
# react-server-dom-esm (dev: real modules, live import) and
# react-server-dom-webpack (prod: module-map reference resolution).
#
# react-server-dom-esm is not published to npm by the React team.
# react-server-dom-webpack is — but vendoring it from the SAME checkout at
# the SAME ref keeps both transports bound to one React build's internals
# under one rsl version (and one rsl revision), instead of asking every
# consumer to pin two packages to the same nightly by hand. This script
# clones React, runs React's own build pipeline to produce both transports,
# and copies the results into vendor/.
#
# Only the transports are vendored. React itself and react-dom come
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
#   --revision <N>                    EXPERIMENTAL ONLY. Append `.N` to the
#                                     version — an rsl revision on top of the
#                                     same React build, so an rsl-only fix can
#                                     ship without waiting for a new React
#                                     nightly. The peer keeps naming the real
#                                     React build (no `.N`). Stable owns its
#                                     patch in package.json and ignores this.
#
# Prerequisites:
#   - yarn (React's repo uses yarn workspaces).
#   - Node.js 18+.
#   - java (for Google Closure Compiler, used by React's build).
#
# Output: vendor/react-server-dom-esm/ and vendor/react-server-dom-webpack/
# — package.json from React's source plus the cjs/ (and esm/) artifacts from
# the build. The vendor/ directory is gitignored locally and included in the
# published npm tarball.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(dirname "$SCRIPT_DIR")"
VENDOR_DIR="$PKG_DIR/vendor"

CHANNEL="experimental"
REACT_REF=""
REACT_DIR=""
REVISION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel) CHANNEL="$2"; shift 2 ;;
    --react-ref) REACT_REF="$2"; shift 2 ;;
    --react-dir) REACT_DIR="$2"; shift 2 ;;
    --revision) REVISION="$2"; shift 2 ;;
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

# --revision is the experimental train's equivalent of stable's rsl-owned patch:
# it appends `.N` to the version WITHOUT touching the peer, so an rsl-only fix can
# ship against a React nightly that has already been published against. Stable
# already owns its patch in package.json, so the flag is meaningless there.
if [[ -n "$REVISION" ]]; then
  if [[ "$CHANNEL" != "experimental" ]]; then
    echo "--revision applies to the experimental train only; stable owns its patch in package.json." >&2
    exit 1
  fi
  if ! [[ "$REVISION" =~ ^[0-9]+$ ]]; then
    echo "Invalid --revision '$REVISION'. Expected a non-negative integer (e.g. 1)." >&2
    exit 1
  fi
fi

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
# Force the switch (-f). React's rollup build stamps packages/shared/ReactVersion.js
# in place with the channel version, so after a build the checkout is dirty. A
# plain `git checkout <ref>` then refuses to switch ("local changes would be
# overwritten"), which means a second train (stable after experimental in
# --both, or any repeat run) can never check out its ref. -f discards that
# build scratch — safe here because this checkout is ours to build from (use
# --react-dir to point at a tree you want left untouched).
(
  cd "$REACT_DIR"
  git fetch --depth 1 origin "$REACT_REF" 2>/dev/null || true
  git checkout -f "$REACT_REF" 2>/dev/null \
    || git checkout -f "origin/$REACT_REF" 2>/dev/null \
    || git checkout -f FETCH_HEAD 2>/dev/null
) || {
  echo "ERROR: could not check out React ref '$REACT_REF' in $REACT_DIR." >&2
  echo "       Fetch it first (cd $REACT_DIR && git fetch origin $REACT_REF)" >&2
  echo "       or pass --react-ref <an available tag/branch/sha>." >&2
  exit 1
}
echo "    React now at: $(cd "$REACT_DIR" && git rev-parse --short HEAD) ($(cd "$REACT_DIR" && git describe --tags --always 2>/dev/null))"

echo ""
echo "==> Injecting esm edge (Web-streams) bundle wiring ..."
# The forced checkout above restored bundles.js / inlinedHostConfigs.js to
# pristine. Re-apply the edge source overlay + build-config patches so React's
# rollup emits react-server-dom-esm-server.edge.* alongside the node bundle.
# Idempotent; never committed to the React checkout. See inject-edge-bundle.mjs.
node "$SCRIPT_DIR/inject-edge-bundle.mjs" "$REACT_DIR"

echo ""
echo "==> Installing React's build dependencies (yarn) ..."
cd "$REACT_DIR"

if ! command -v yarn >/dev/null 2>&1; then
  echo "ERROR: yarn is required but not installed." >&2
  exit 1
fi

yarn install --frozen-lockfile 2>&1 | tail -5

# Both transports build from the SAME checkout at the SAME ref, so they share
# one React build's internals and one version. esm is the dev transport (real
# modules, live import); webpack is the prod transport (module-map reference
# resolution -> self-contained baked bundles).
TRANSPORTS="react-server-dom-esm react-server-dom-webpack"

echo ""
echo "==> Building $TRANSPORTS (~2 min) ..."
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
  for t in $TRANSPORTS; do rm -rf "$REACT_DIR/build/node_modules/$t"; done
  set +o pipefail
  RELEASE_CHANNEL="$CHANNEL" node scripts/rollup/build.js \
    react-server-dom-esm,react-server-dom-webpack 2>&1 | tail -20 || true
  set -o pipefail
  BUILD_OK=true
  for t in $TRANSPORTS; do
    [ -d "$REACT_DIR/build/node_modules/$t" ] || BUILD_OK=false
  done
  [ "$BUILD_OK" = "true" ] && break
done

if [ "$BUILD_OK" != "true" ]; then
  echo "ERROR: transport build output not found under $REACT_DIR/build/node_modules/" >&2
  echo "       React's rollup build failed 3 times. Re-run, or build it by hand:" >&2
  echo "       (cd $REACT_DIR && RELEASE_CHANNEL=$CHANNEL node scripts/rollup/build.js react-server-dom-esm,react-server-dom-webpack)" >&2
  exit 1
fi

for t in $TRANSPORTS; do
  if [ ! -f "$REACT_DIR/packages/$t/package.json" ]; then
    echo "ERROR: $t source package.json not found at $REACT_DIR/packages/$t/package.json" >&2
    exit 1
  fi
done

echo ""
echo "==> Vendoring $TRANSPORTS into $VENDOR_DIR ..."
for t in $TRANSPORTS; do
  rm -rf "$VENDOR_DIR/$t"
  mkdir -p "$VENDOR_DIR/$t"
  cp -r "$REACT_DIR/build/node_modules/$t"/. "$VENDOR_DIR/$t/"
  cp "$REACT_DIR/packages/$t/package.json" "$VENDOR_DIR/$t/package.json"
  for f in LICENSE README.md; do
    [ -f "$REACT_DIR/packages/$t/$f" ] && cp "$REACT_DIR/packages/$t/$f" "$VENDOR_DIR/$t/$f"
  done
done

# The webpack package also builds webpack-consumer artifacts rsl doesn't
# serve: the webpack bundler plugin, the CJS require() register hook, and the
# node ESM loader (rsl ships its own loader). Prune them so the tarball stays
# lean and nothing in the package implies a webpack peer.
rm -f "$VENDOR_DIR/react-server-dom-webpack/cjs/react-server-dom-webpack-plugin"*.js \
      "$VENDOR_DIR/react-server-dom-webpack/cjs/react-server-dom-webpack-node-register"*.js \
      "$VENDOR_DIR/react-server-dom-webpack/esm/react-server-dom-webpack-node-loader"*.js \
      "$VENDOR_DIR/react-server-dom-webpack/plugin.js" \
      "$VENDOR_DIR/react-server-dom-webpack/node-register.js"

# React's source includes flow-typed shim files alongside the
# package.json (index.js, client.js, server.node.js, …). Those source
# shims aren't directly loadable in Node — they're an ESM/@flow shape
# rewritten by React's packaging step into the conditional-require
# shape consumers actually import. Generate the publishable shims
# here instead of running React's full packaging step (which fails
# on unrelated downstream packages on a clean checkout).
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
#   experimental -> version = 0.0.0-experimental-<sha>-<date>[.<rsl-revision>],
#                   peer    = 0.0.0-experimental-<sha>-<date>  (that EXACT string,
#                             and NEVER with the revision — react@<build>.1 does
#                             not exist and would 404 the install and the gate).
#                   Internals change per commit, so the peer must be exact — a
#                   wider range would let a consumer pair this transport with a
#                   different experimental React and crash on the
#                   ReactSharedInternals/"older version of React" mismatch.
#                   sha  = `git rev-parse HEAD`, first 8 chars
#                   date = committer date YYYYMMDD in the commit's own tz (matches
#                          facebook/react build-all-release-channels.js, NOT UTC)
#                   `--revision N` appends `.N`: rsl owns its revision on THIS
#                   train too, so an rsl-only fix can ship against a React
#                   nightly already published against, instead of waiting for
#                   React to cut a new one. `.1` sorts above the bare string and
#                   below any stable version.
#
# We are still cd'd into the React checkout here, so git reads its HEAD.
RSL_SHA=$(git rev-parse HEAD | cut -c1-8)
RSL_DATE=$(git show -s --no-show-signature --format=%cd --date=format:%Y%m%d "$RSL_SHA")
RSL_DATE=${RSL_DATE#\'}            # strip CI quote-wrapping ('...' )
RSL_DATE=${RSL_DATE%\'}
RSL_CHANNEL="$CHANNEL" RSL_SHA="$RSL_SHA" RSL_DATE="$RSL_DATE" \
  RSL_REVISION="$REVISION" \
  RSL_REACT="$REACT_VERSION" RSL_OWN_PKG="$PKG_DIR/package.json" \
  RSL_VENDOR_PKG="$VENDOR_DIR/react-server-dom-esm/package.json" \
  RSL_VENDOR_PKG_WEBPACK="$VENDOR_DIR/react-server-dom-webpack/package.json" node -e '
  const fs = require("fs");
  const { RSL_OWN_PKG, RSL_VENDOR_PKG, RSL_VENDOR_PKG_WEBPACK, RSL_CHANNEL, RSL_SHA, RSL_DATE, RSL_REACT, RSL_REVISION } = process.env;
  const pkg = JSON.parse(fs.readFileSync(RSL_OWN_PKG, "utf8"));   // rsl itself
  const reactFull = RSL_REACT;                                    // vendored React in-repo version, e.g. 19.2.7
  let peer;
  if (RSL_CHANNEL === "experimental") {
    // The React build this transport was vendored from. This string is REAL —
    // React publishes it — so it is what the peer must name, and what the
    // release gate installs to test against.
    const reactBuild = `0.0.0-experimental-${RSL_SHA}-${RSL_DATE}`;
    peer = reactBuild;                                            // EXACT pin (internals per-sha)
    // rsl OWNS its version here too, exactly as it does on stable: `.N` is an
    // rsl revision on top of that React build. Without it, an rsl-only fix (a
    // loader/transformer bug, no React change) has NO version to ship under and
    // is stuck until React cuts a new nightly — the same trap the @types-style
    // patch was introduced to escape on the stable train. `.1` sorts above the
    // bare string and stays below any stable version, so the dist-tag moves
    // forward cleanly and plain installs are untouched.
    //
    // The peer deliberately does NOT get the revision: react@<build>.1 does not
    // exist, so naming it would 404 both the install and the release gate (which
    // installs react@<peer> to test against).
    pkg.version = RSL_REVISION ? `${reactBuild}.${RSL_REVISION}` : reactBuild;
  } else {
    // stable: @types-style. rsl OWNS its version (kept from package.json) so
    // rsl-only fixes can ship without waiting for a new React; major.minor
    // tracks the React minor, the patch is an rsl-owned revision. The peer
    // floors at the vendored React (caret reactFull) — React compat lives in
    // the peer, not the version string, so this stays sound w.r.t. the
    // ReactSharedInternals bind.
    const [rmaj, rmin] = reactFull.split(".");
    const [omaj, omin] = String(pkg.version).split(".");
    if (`${omaj}.${omin}` !== `${rmaj}.${rmin}`) {
      console.warn(`WARNING: react-server-loader ${pkg.version} major.minor != vendored React ${rmaj}.${rmin}. ` +
        `Set package.json version to ${rmaj}.${rmin}.0 for the new React minor before publishing.`);
    }
    peer = `^${reactFull}`;                                       // React stable transport convention
  }
  pkg.peerDependencies = { ...pkg.peerDependencies, react: peer, "react-dom": peer };
  fs.writeFileSync(RSL_OWN_PKG, JSON.stringify(pkg, null, 2) + "\n");
  // Keep BOTH vendored transport package.json versions in lockstep with rsl, so
  // the three are consistent (and the publish guard can assert version === vendor).
  // For stable this is a no-op (all = React version); for experimental it sets
  // the transports to the same 0.0.0-experimental-<sha> string.
  for (const vendorPath of [RSL_VENDOR_PKG, RSL_VENDOR_PKG_WEBPACK]) {
    const vpkg = JSON.parse(fs.readFileSync(vendorPath, "utf8"));
    vpkg.version = pkg.version;
    fs.writeFileSync(vendorPath, JSON.stringify(vpkg, null, 2) + "\n");
  }
  console.log(`stamped react-server-loader: version=${pkg.version} peer.react=${peer}`);
'

VERSION=$(node -p "require('$PKG_DIR/package.json').version" 2>/dev/null || echo "unknown")

echo ""
echo "==> Done. Vendored react-server-dom-esm + react-server-dom-webpack: $REACT_VERSION (channel $CHANNEL)"
echo "    react-server-loader will publish as: $VERSION  (vendors react $REACT_VERSION)"
echo "    Output: $VENDOR_DIR/react-server-dom-esm/ + $VENDOR_DIR/react-server-dom-webpack/"
echo ""
echo "package.json now carries the publish-ready version + peer. Next:"
echo "  npm run verify   # gate against a real consumer"
echo "  npm pack && npm publish <tgz> --tag $([ "$CHANNEL" = experimental ] && echo experimental || echo latest)"
echo "  (stable keeps package.json's own version (@types-style); experimental"
echo "   stamps a 0.0.0-experimental-<sha> snapshot — git checkout package.json after.)"
