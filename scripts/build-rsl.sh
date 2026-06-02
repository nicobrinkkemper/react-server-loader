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
# rsl's OWN package.json is the single source of truth for what gets
# published — version and react/react-dom peer. The build derives the peer
# (and, for experimental, the version) from the React it just vendored, so
# a local `npm pack && npm publish` is correct with no extra steps. The
# vendored transport's own package.json is left exactly as React shipped it.
#
# Two schemes, one per channel (see README "Versioning"):
#
# experimental — snapshot of one React build, mirroring React's own format
#   (facebook/react scripts/rollup/build-all-release-channels.js):
#     sha     = `git rev-parse HEAD`, first 8 chars
#     date    = committer date of that sha, YYYYMMDD, in the commit's own
#               timezone (NOT UTC — matches React's --date=format:%Y%m%d)
#     version = 0.0.0-experimental-<sha>-<date>, react/react-dom peer = that exact string.
#   Patch by republishing with a trailing `.N`. (Don't commit this version
#   bump — it's a per-build snapshot; `git checkout package.json` after.)
#
# stable — @types-style: major.minor tracks React, the PATCH is rsl's own
#   revision (maintainer-bumped in package.json), so rsl can ship a fix
#   without waiting for a new React release. The build leaves the version
#   alone and only sets the peer floor.
#     version = react-server-loader's own (e.g. 19.2.0, 19.2.1, …)
#     peer    = ">=<vendored React> <next React minor>"  (e.g. >=19.2.7 <19.3.0)
#
# We are still cd'd into the React checkout here, so git reads its HEAD.
RSL_SHA=$(git rev-parse HEAD | cut -c1-8)
RSL_DATE=$(git show -s --no-show-signature --format=%cd --date=format:%Y%m%d "$RSL_SHA")
RSL_DATE=${RSL_DATE#\'}            # strip CI quote-wrapping ('...' )
RSL_DATE=${RSL_DATE%\'}
RSL_CHANNEL="$CHANNEL" RSL_SHA="$RSL_SHA" RSL_DATE="$RSL_DATE" \
  RSL_REACT="$REACT_VERSION" RSL_OWN_PKG="$PKG_DIR/package.json" node -e '
  const fs = require("fs");
  const { RSL_OWN_PKG, RSL_CHANNEL, RSL_SHA, RSL_DATE, RSL_REACT } = process.env;
  const pkg = JSON.parse(fs.readFileSync(RSL_OWN_PKG, "utf8"));   // rsl itself
  const reactFull = RSL_REACT;                                    // vendored React, e.g. 19.2.7
  let peer;
  if (RSL_CHANNEL === "experimental") {
    pkg.version = `0.0.0-experimental-${RSL_SHA}-${RSL_DATE}`;    // snapshot, derived
    peer = pkg.version;                                           // exact pin
  } else {
    // stable: keep rsl-owned version; peer floors at the vendored React,
    // capped at the next minor.
    const [maj, min] = reactFull.split(".");
    const [omaj, omin] = String(pkg.version).split(".");
    if (`${omaj}.${omin}` !== `${maj}.${min}`) {
      console.warn(`WARNING: react-server-loader ${pkg.version} major.minor != React ${maj}.${min}. ` +
        `Bump package.json to ${maj}.${min}.0 (new React minor) before publishing.`);
    }
    peer = `>=${reactFull} <${maj}.${Number(min) + 1}.0`;
  }
  pkg.peerDependencies = { ...pkg.peerDependencies, react: peer, "react-dom": peer };
  fs.writeFileSync(RSL_OWN_PKG, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`stamped react-server-loader: version=${pkg.version} peer.react=${peer}`);
'

VERSION=$(node -p "require('$PKG_DIR/package.json').version" 2>/dev/null || echo "unknown")

echo ""
echo "==> Done. Vendored react-server-dom-esm: $REACT_VERSION (channel $CHANNEL)"
echo "    react-server-loader will publish as: $VERSION"
echo "    Output: $VENDOR_DIR/react-server-dom-esm/"
echo ""
echo "package.json now carries the publish-ready version + peer. Next:"
echo "  npm run verify   # gate against a real consumer"
echo "  npm pack && npm publish <tgz> --tag $([ "$CHANNEL" = experimental ] && echo experimental || echo latest)"
if [ "$CHANNEL" = "experimental" ]; then
  echo "  (experimental bumps package.json's version — git checkout package.json after publishing)"
fi
