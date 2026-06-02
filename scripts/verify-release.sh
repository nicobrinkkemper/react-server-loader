#!/usr/bin/env bash
set -euo pipefail

# verify-release.sh — pre-publish confidence gate for react-server-loader.
#
# rsl is fundamentally a deterministic "copy React's built transport +
# normalize for ESM" pipeline, plus its own loader/transformer code. Its
# unit tests cover the latter; nothing else proves the assembled package
# actually *renders* an RSC tree end to end. This gate closes that gap so
# we can publish rarely and confidently instead of chasing patch releases.
#
# What it does:
#   1. Build (or take) the exact rsl tarball that would be published.
#   2. Install that tarball into a real consumer (vprs by default),
#      replacing its source link — so we test the packaged bytes, not src.
#   3. Run the consumer's integration suite against it (real RSC render:
#      server -> wire -> client). Green = safe to publish; red = stop.
#   4. Restore the consumer's original rsl link on exit, ALWAYS.
#
# Usage:
#   scripts/verify-release.sh                          # build experimental (default), verify
#   scripts/verify-release.sh --channel stable --react-ref v19.2.7
#   scripts/verify-release.sh --tarball ./react-server-loader-19.2.0.tgz
#
# Env overrides:
#   CONSUMER_DIR     consumer repo (default: ../vite-plugin-react-server)
#   VERIFY_TEST_CMD  command run inside the consumer; eval'd
#                    (default: the full-pipeline integration slice below)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(dirname "$SCRIPT_DIR")"
CONSUMER_DIR="${CONSUMER_DIR:-$PKG_DIR/../vite-plugin-react-server}"
# Deterministic full-pipeline tests; avoids the flaky dev-server/e2e harness.
VERIFY_TEST_CMD="${VERIFY_TEST_CMD:-npm run test:build && npm run test:streams}"

CHANNEL=""
REACT_REF=""
TARBALL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --channel)   CHANNEL="$2"; shift 2 ;;
    --react-ref) REACT_REF="$2"; shift 2 ;;
    --tarball)   TARBALL="$2"; shift 2 ;;
    -h|--help)   sed -n '3,33p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ ! -d "$CONSUMER_DIR/node_modules" ]; then
  echo "ERROR: consumer not found / not installed at $CONSUMER_DIR" >&2
  echo "       set CONSUMER_DIR to a repo that consumes react-server-loader." >&2
  exit 1
fi

# 1. Obtain the tarball ------------------------------------------------------
if [ -z "$TARBALL" ]; then
  echo "==> Building rsl tarball (channel=${CHANNEL:-default} ref=${REACT_REF:-default}) ..."
  bash "$SCRIPT_DIR/build-rsl.sh" \
    ${CHANNEL:+--channel "$CHANNEL"} \
    ${REACT_REF:+--react-ref "$REACT_REF"}
  ( cd "$PKG_DIR" && npm run build >/dev/null && npm pack >/dev/null )
  TARBALL="$(ls -t "$PKG_DIR"/react-server-loader-*.tgz | head -1)"
fi
# absolutize
TARBALL="$(cd "$(dirname "$TARBALL")" && pwd)/$(basename "$TARBALL")"
[ -f "$TARBALL" ] || { echo "ERROR: tarball not found: $TARBALL" >&2; exit 1; }

WORK="$(mktemp -d)"
tar -xzf "$TARBALL" -C "$WORK"            # -> $WORK/package
PKG_VERSION="$(node -p "require('$WORK/package/package.json').version")"

echo "==> Verifying react-server-loader@$PKG_VERSION"
echo "    tarball:  $TARBALL"
echo "    consumer: $CONSUMER_DIR"
echo "    test:     $VERIFY_TEST_CMD"

# 2. Swap the tarball into the consumer, with guaranteed restore -------------
LINK="$CONSUMER_DIR/node_modules/react-server-loader"
BACKUP="$LINK.rsl-verify-backup"
ORIG_KIND="none"
ORIG_TARGET=""

restore() {
  rm -rf "$LINK"
  case "$ORIG_KIND" in
    symlink) ln -s "$ORIG_TARGET" "$LINK" ;;
    dir)     [ -e "$BACKUP" ] && mv "$BACKUP" "$LINK" ;;
    none)    : ;;
  esac
  rm -rf "$WORK"
  echo "==> Restored consumer's original react-server-loader link."
}
trap restore EXIT

if [ -L "$LINK" ]; then
  ORIG_KIND="symlink"; ORIG_TARGET="$(readlink "$LINK")"; rm -f "$LINK"
elif [ -e "$LINK" ]; then
  ORIG_KIND="dir"; rm -rf "$BACKUP"; mv "$LINK" "$BACKUP"
fi
cp -r "$WORK/package" "$LINK"

# 3. Run the consumer's integration suite against the packaged tarball -------
echo "==> Running consumer integration suite ..."
set +e
( cd "$CONSUMER_DIR" && eval "$VERIFY_TEST_CMD" )
RESULT=$?
set -e

echo ""
if [ "$RESULT" -eq 0 ]; then
  echo "✅ VERIFY PASSED — react-server-loader@$PKG_VERSION is safe to publish."
else
  echo "❌ VERIFY FAILED — do NOT publish react-server-loader@$PKG_VERSION (exit $RESULT)."
fi
exit "$RESULT"
