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
#   3. Run the consumer's WHOLE suite against it (real RSC render: server ->
#      wire -> client, plus its unit and typecheck passes). Green = safe to
#      publish; red = stop.
#   4. Restore the consumer's original rsl link on exit, ALWAYS.
#
# The gate used to run a curated slice (`test:build && test:streams`) to dodge
# the dev-server harness. That slice has now let two regressions through to npm,
# both caught by the consumer's UNIT tests and both requiring an emergency patch
# the same day:
#
#   19.2.13  a misplaced `"use client"` was silently dropped instead of throwing
#            (vprs test/unit/viteInjectedCode)          -> emergency 19.2.14
#   19.2.15  the `"use server"` gate stopped seeing directives in nested
#            functions — React's canonical inline Server Function — so those
#            modules were never transformed at all
#            (vprs test/unit/source-map, test/unit/createModuleID)
#                                                        -> emergency 19.2.16
#
# A gate that a regression can walk past is not a gate. Run the consumer's own
# canonical command, not a subset of it. It is slower; a release is rare.
#
# Usage:
#   scripts/verify-release.sh                          # build experimental (default), verify
#   scripts/verify-release.sh --channel stable --react-ref v19.2.7
#   scripts/verify-release.sh --tarball ./react-server-loader-19.2.0.tgz
#
# Env overrides:
#   CONSUMER_DIR     consumer repo (default: ../vite-plugin-react-server)
#   VERIFY_TEST_CMD  command run inside the consumer; eval'd. Narrow it for a
#                    fast local iteration if you must — but not for a release.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(dirname "$SCRIPT_DIR")"
CONSUMER_DIR="${CONSUMER_DIR:-$PKG_DIR/../vite-plugin-react-server}"
# The consumer's canonical gate: server + client + unit + typecheck. A strict
# superset of the old slice (its `test:server` runs every test file under the
# react-server condition, `test:build`/`test:streams` included).
VERIFY_TEST_CMD="${VERIFY_TEST_CMD:-npm run test-all}"

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
PEER_REACT="$(node -p "require('$WORK/package/package.json').peerDependencies.react")"

# The Flight server/client share internals with the react package itself, so
# an experimental transport only runs against the exact React it was built
# from (that's why the experimental train pins its peer exactly). Gate the
# experimental tarball against THAT React, not the consumer's stable install —
# otherwise the gate fails on internals skew, not on anything rsl shipped.
SWAP_REACT="false"
case "$PEER_REACT" in
  0.0.0-experimental-*|*-canary-*) SWAP_REACT="true" ;;
esac

echo "==> Verifying react-server-loader@$PKG_VERSION"
echo "    tarball:  $TARBALL"
echo "    consumer: $CONSUMER_DIR"
echo "    react:    $PEER_REACT$([ "$SWAP_REACT" = "true" ] && echo " (staged into consumer for the gate)" || true)"
echo "    test:     $VERIFY_TEST_CMD"

# 2. Swap the tarball into the consumer, with guaranteed restore -------------
LINK="$CONSUMER_DIR/node_modules/react-server-loader"
BACKUP="$LINK.rsl-verify-backup"
ORIG_KIND="none"
ORIG_TARGET=""

REACT_SWAPPED=""

restore() {
  rm -rf "$LINK"
  case "$ORIG_KIND" in
    symlink) ln -s "$ORIG_TARGET" "$LINK" ;;
    dir)     [ -e "$BACKUP" ] && mv "$BACKUP" "$LINK" ;;
    none)    : ;;
  esac
  for m in $REACT_SWAPPED; do
    rm -rf "$CONSUMER_DIR/node_modules/$m"
    [ -e "$CONSUMER_DIR/node_modules/$m.rsl-verify-backup" ] &&
      mv "$CONSUMER_DIR/node_modules/$m.rsl-verify-backup" "$CONSUMER_DIR/node_modules/$m"
  done
  if [ -n "$REACT_SWAPPED" ]; then
    rm -rf "$CONSUMER_DIR/node_modules/.vite"
    echo "==> Restored consumer's original react family ($REACT_SWAPPED )."
  fi
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

# 2b. Experimental train: stage the matching React family into the consumer --
if [ "$SWAP_REACT" = "true" ]; then
  echo "==> Staging react@$PEER_REACT (+ matching react-dom, scheduler) ..."
  # A real npm install resolves the matching scheduler for us.
  npm install --prefix "$WORK/react-stage" --no-save --silent \
    "react@$PEER_REACT" "react-dom@$PEER_REACT"
  for m in react react-dom scheduler; do
    src="$WORK/react-stage/node_modules/$m"
    [ -d "$src" ] || { echo "ERROR: staged $m missing at $src" >&2; exit 1; }
    tgt="$CONSUMER_DIR/node_modules/$m"
    rm -rf "$tgt.rsl-verify-backup"
    [ -e "$tgt" ] && mv "$tgt" "$tgt.rsl-verify-backup"
    cp -r "$src" "$tgt"
    REACT_SWAPPED="$REACT_SWAPPED $m"
  done
  # Vite prebundle caches won't notice a dir swap — clear so the gate can't
  # run against stale stable-React bytes.
  rm -rf "$CONSUMER_DIR/node_modules/.vite"
fi

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
