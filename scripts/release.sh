#!/usr/bin/env bash
set -euo pipefail

# Cut a react-server-loader release, locally and reproducibly. Per train:
#   1. build + vendor the react-server-dom-esm transport (stamp version+peer)
#   2. guard the state (check-publishable.mjs) + pack (prepack rebuilds dist)
#   3. gate the tarball against the consumer (verify-release.sh)
#   4. npm publish the exact tarball under the train's dist-tag
#
# No npm token ever lives on GitHub — this runs on the maintainer's machine
# under their own `npm login`.
#
# Usage:
#   npm run release                                  # stable, React v<package.json version>
#   ./scripts/release.sh --react-ref v19.2.8         # stable, bump to React 19.2.8
#   ./scripts/release.sh --channel experimental      # experimental train (React main)
#   ./scripts/release.sh --channel experimental --react-ref <sha> --revision 1
#                                                   # ship an rsl-only fix against a
#                                                   # React nightly already published
#                                                   # against: version gets `.1`, the
#                                                   # peer keeps naming the real React.
#                                                   # Without this, an rsl bug on the
#                                                   # experimental train is stuck until
#                                                   # React cuts a new nightly.
#   ./scripts/release.sh --both                      # experimental THEN stable, one command
#   ./scripts/release.sh --both --stable-ref v19.2.7 --experimental-ref main
#   ./scripts/release.sh --dry-run                   # build + guard + gate + pack, no publish
#   ./scripts/release.sh --react-dir ~/code/react-stable   # build from a dedicated React checkout
#
# --react-dir points the transport build at an existing React checkout instead
# of the auto-detected sibling (`../react`). Use it to keep a working React tree
# (e.g. one on a feature branch) untouched: clone a dedicated checkout once and
# build releases from there. Forwarded verbatim to build-rsl.sh.
#
# --both runs experimental first, stable last, so package.json ends stamped at
# the stable version (clean tree). The two are separate versions (19.2.7 vs
# 0.0.0-experimental-<sha>) under separate dist-tags (latest / experimental) —
# they coexist on npm; this just publishes both back to back.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PKG_DIR"

CHANNEL="stable"
REACT_REF=""
REACT_DIR=""
BOTH="false"
STABLE_REF=""
EXPERIMENTAL_REF=""
DRY_RUN="false"
REVISION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --channel)          CHANNEL="$2"; shift 2 ;;
    --revision)         REVISION="$2"; shift 2 ;;
    --react-ref)        REACT_REF="$2"; shift 2 ;;
    --react-dir)        REACT_DIR="$2"; shift 2 ;;
    --both)             BOTH="true"; shift ;;
    --stable-ref)       STABLE_REF="$2"; shift 2 ;;
    --experimental-ref) EXPERIMENTAL_REF="$2"; shift 2 ;;
    --dry-run)          DRY_RUN="true"; shift ;;
    # Anchored on the code, not a line number — a hardcoded range silently
    # truncates the help the moment anyone adds a line to the header.
    -h|--help)          sed -n '4,/^SCRIPT_DIR=/p' "$0" | sed '$d'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Release one train: channel, React ref, npm dist-tag.
release_one() {
  local channel="$1" ref="$2" tag="$3"
  echo ""
  echo "==> Train: channel=$channel  react-ref=$ref  dist-tag=$tag"
  echo "==> [1/4] Building + vendoring the transport ..."
  # --revision applies to the experimental train only (stable owns its patch in
  # package.json), so only forward it there — passing it to stable is an error.
  bash "$SCRIPT_DIR/build-rsl.sh" --channel "$channel" --react-ref "$ref" \
    ${REACT_DIR:+--react-dir "$REACT_DIR"} \
    $([ "$channel" = "experimental" ] && [ -n "$REVISION" ] && echo "--revision $REVISION")

  echo "==> [2/4] Guard + pack ..."
  node "$SCRIPT_DIR/check-publishable.mjs"
  npm pack >/dev/null
  local tgz version
  tgz="$(ls -t "$PKG_DIR"/react-server-loader-*.tgz | head -1)"
  version="$(node -p "require('./package.json').version")"
  echo "    packed: $tgz"

  echo "==> [3/4] Gating against the consumer ..."
  bash "$SCRIPT_DIR/verify-release.sh" --tarball "$tgz"

  if [ "$DRY_RUN" = "true" ]; then
    echo "==> DRY RUN — built, guarded, gated, packed react-server-loader@$version ($tag). Not published."
    rm -f "$tgz"
    return 0
  fi

  echo "==> [4/4] Publishing react-server-loader@$version (tag $tag) ..."
  npm publish "$tgz" --access public --tag "$tag"
  rm -f "$tgz"
  echo "==> Published react-server-loader@$version @ $tag"
}

# Under @types-style stable versioning, package.json's version is rsl's own
# (e.g. 19.2.8); the React to vendor is named by the peer (^19.2.7). So the
# default stable build ref comes from the peer, not the version.
stable_react_ref() {
  node -p "'v' + (require('./package.json').peerDependencies.react.match(/[0-9]+[.][0-9]+[.][0-9]+/) || ['0.0.0'])[0]"
}

if [ "$BOTH" = "true" ]; then
  # Capture the stable version BEFORE the experimental build mutates package.json.
  STABLE_VERSION="$(node -p "require('./package.json').version")"
  EXP_REF="${EXPERIMENTAL_REF:-main}"
  STB_REF="${STABLE_REF:-$(stable_react_ref)}"
  echo "==> Releasing BOTH trains: experimental ($EXP_REF) then stable ($STB_REF)."
  release_one experimental "$EXP_REF" experimental

  # The experimental leg STAMPS package.json's version. build-rsl.sh's stable
  # path never writes a version — it KEEPS whatever package.json holds — so
  # without this restore, stable inherits the experimental string and tries to
  # publish `0.0.0-experimental-<sha>` under the `latest` tag. (The peer needs no
  # restore: the stable build rewrites it to ^<vendored React>.)
  RSL_STABLE_VERSION="$STABLE_VERSION" node -e '
    const fs = require("fs");
    const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
    p.version = process.env.RSL_STABLE_VERSION;
    fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");
  '
  echo "==> Restored package.json to the stable version ($STABLE_VERSION) for the stable leg."

  release_one stable "$STB_REF" latest
  echo ""
  echo "==> Both trains done. package.json restored to stable ($STABLE_VERSION)."
  exit 0
fi

# Single train.
if [ -z "$REACT_REF" ]; then
  if [ "$CHANNEL" = "experimental" ]; then
    REACT_REF="main"
  else
    REACT_REF="$(stable_react_ref)"
  fi
fi
TAG=$([ "$CHANNEL" = "experimental" ] && echo "experimental" || echo "latest")
release_one "$CHANNEL" "$REACT_REF" "$TAG"
if [ "$CHANNEL" = "experimental" ] && [ "$DRY_RUN" = "false" ]; then
  echo "    Experimental stamped package.json — run: git checkout package.json"
fi
