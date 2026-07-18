// Pre-publish guard (wired to `prepublishOnly`). Fails `npm publish` unless the
// package is in a coherent, publishable state — i.e. both vendored transports
// have been built and their versions match package.json. This is the safety net
// for a bare `npm publish`; the happy path is `npm run release`
// (scripts/release.sh), which builds, gates, and publishes for you.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// Both transports vendor from the same React checkout at the same ref, so both
// must be present, complete, and stamped with rsl's own version. The listed
// files are what the exports map points at.
const TRANSPORTS = {
  "react-server-dom-esm": ["server.node.js", "client.node.js", "client.browser.js"],
  "react-server-dom-webpack": [
    "server.node.js",
    "server.edge.js",
    "client.node.js",
    "client.browser.js",
    "client.edge.js",
  ],
};

function fail(reason) {
  console.error(
    "\n✖ react-server-loader is not publishable:\n  " +
      reason +
      "\n\n  Releases go through:  npm run release  (scripts/release.sh)\n" +
      "  which builds the vendored transports, gates them against the consumer,\n" +
      "  and publishes. Don't run a bare `npm publish`. See docs/versioning.md\n" +
      "  and docs/internals/vendoring-and-publishing.md.\n"
  );
  process.exit(1);
}

for (const [name, requiredFiles] of Object.entries(TRANSPORTS)) {
  const vendorPkgPath = join(root, "vendor", name, "package.json");

  // 1. The vendored transport must exist.
  if (!existsSync(vendorPkgPath)) {
    fail(
      "the vendored " + name + " transport is missing — vendor/ is not built.\n" +
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
        " but the vendored " + name + " is " +
        vendor.version +
        ".\n  rsl's version must equal the transport version it ships.\n" +
        "  Rebuild:  ./scripts/build-rsl.sh --channel <stable|experimental> --react-ref <ref>"
    );
  }

  // 3. The transport build must be complete (the files the exports map points at).
  for (const file of requiredFiles) {
    if (!existsSync(join(root, "vendor", name, file))) {
      fail(
        "the vendored " + name + " is incomplete (missing " +
          file +
          ") — rebuild via build-rsl.sh."
      );
    }
  }
}

console.log(
  "✓ publishable: react-server-loader@" +
    pkg.version +
    " (vendored react-server-dom-esm + react-server-dom-webpack @" +
    pkg.version +
    ")"
);
