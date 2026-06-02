#!/usr/bin/env bash
set -euo pipefail

# Cut a react-server-loader release, locally and reproducibly:
#   1. build + vendor the react-server-dom-esm transport (and stamp version+peer)
#   2. pack the tarball (prepack rebuilds dist; prepublishOnly guards state)
#   3. gate it against the consumer (scripts/verify-release.sh)
#   4. npm publish the exact tarball
#
# No npm token ever lives on GitHub — this runs on the maintainer's machine
# under their own `npm login`.
#
# Usage:
#   npm run release                                  # stable, React v<package.json version>
#   ./scripts/release.sh --react-ref v19.2.8         # stable, bump to React 19.2.8
#   ./scripts/release.sh --channel experimental      # experimental train (React main)
#   ./scripts/release.sh --dry-run                   # build + gate + pack, do NOT publish

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PKG_DIR"

CHANNEL="stable"
REACT_REF=""
DRY_RUN="false"
while [ $# -gt 0 ]; do
  case "$1" in
    --channel)   CHANNEL="$2"; shift 2 ;;
    --react-ref) REACT_REF="$2"; shift 2 ;;
    --dry-run)   DRY_RUN="true"; shift ;;
    -h|--help)   sed -n '3,21p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Defaults: stable rebuilds the React version already stamped (version===transport);
# experimental tracks React main. The dist-tag follows the channel.
if [ -z "$REACT_REF" ]; then
  if [ "$CHANNEL" = "experimental" ]; then
    REACT_REF="main"
  else
    REACT_REF="v$(node -p "require('./package.json').version")"
  fi
fi
TAG=$([ "$CHANNEL" = "experimental" ] && echo "experimental" || echo "latest")

echo "==> Release: channel=$CHANNEL  react-ref=$REACT_REF  dist-tag=$TAG"

echo "==> [1/4] Building + vendoring the transport ..."
bash "$SCRIPT_DIR/build-rsl.sh" --channel "$CHANNEL" --react-ref "$REACT_REF"

echo "==> [2/4] Guard + pack ..."
node "$SCRIPT_DIR/check-publishable.mjs"
npm pack >/dev/null
TGZ="$(ls -t "$PKG_DIR"/react-server-loader-*.tgz | head -1)"
VERSION="$(node -p "require('./package.json').version")"
echo "    packed: $TGZ"

echo "==> [3/4] Gating against the consumer ..."
bash "$SCRIPT_DIR/verify-release.sh" --tarball "$TGZ"

if [ "$DRY_RUN" = "true" ]; then
  echo ""
  echo "==> DRY RUN — built, guarded, gated, and packed react-server-loader@$VERSION."
  echo "    Tarball left at: $TGZ  (not published)."
  exit 0
fi

echo "==> [4/4] Publishing react-server-loader@$VERSION to npm (tag $TAG) ..."
npm publish "$TGZ" --access public --tag "$TAG"
rm -f "$TGZ"
echo "==> Published react-server-loader@$VERSION @ $TAG"
echo "    For experimental snapshots, run: git checkout package.json"
