// Pre-publish guard (wired to `prepublishOnly`). Fails `npm publish` unless the
// package is in a coherent, publishable state — i.e. the vendored transport has
// been built and its version matches package.json. This is the safety net for a
// bare `npm publish`; the happy path is `npm run release` (scripts/release.sh),
// which builds, gates, and publishes for you.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const vendorPkgPath = join(root, "vendor/react-server-dom-esm/package.json");

function fail(reason) {
  console.error(
    "\n✖ react-server-loader is not publishable:\n  " +
      reason +
      "\n\n  Releases go through:  npm run release  (scripts/release.sh)\n" +
      "  which builds the vendored transport, gates it against the consumer,\n" +
      "  and publishes. Don't run a bare `npm publish`. See docs/versioning.md\n" +
      "  and docs/internals/vendoring-and-publishing.md.\n"
  );
  process.exit(1);
}

// 1. The vendored transport must exist.
if (!existsSync(vendorPkgPath)) {
  fail(
    "the vendored react-server-dom-esm transport is missing — vendor/ is not built.\n" +
      "  Build it:  ./scripts/build-rsl.sh --channel stable --react-ref v" +
      pkg.version
  );
}

// 2. rsl's version MUST equal the vendored transport version (the core invariant).
const vendor = JSON.parse(readFileSync(vendorPkgPath, "utf8"));
if (vendor.version !== pkg.version) {
  fail(
    "version mismatch — package.json is " +
      pkg.version +
      " but the vendored transport is " +
      vendor.version +
      ".\n  rsl's version must equal the react-server-dom-esm version it ships.\n" +
      "  Rebuild:  ./scripts/build-rsl.sh --channel <stable|experimental> --react-ref <ref>"
  );
}

// 3. The transport build must be complete (the files the exports map points at).
for (const file of ["server.node.js", "client.node.js", "client.browser.js"]) {
  if (!existsSync(join(root, "vendor/react-server-dom-esm", file))) {
    fail(
      "the vendored transport is incomplete (missing " +
        file +
        ") — rebuild via build-rsl.sh."
    );
  }
}

console.log(
  "✓ publishable: react-server-loader@" +
    pkg.version +
    " (vendored react-server-dom-esm@" +
    vendor.version +
    ")"
);
