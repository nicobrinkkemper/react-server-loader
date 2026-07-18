// Generate the publishable shim entry points for the vendored transports
// (react-server-dom-esm and react-server-dom-webpack).
//
// React's source-tree shim files (in packages/react-server-dom-*/) are
// authored as ES modules with @flow annotations and aren't directly
// loadable in Node. The packaging step in React's repo rewrites them
// into the conditional-require shape (`process.env.NODE_ENV === 'production'
// ? cjs/x.production.js : cjs/x.development.js`) that consumers actually
// import. Rather than run React's full packaging step (which fails on
// downstream packages on a clean checkout), this script writes the
// publishable shims directly. They're stable across React versions —
// only the file names inside cjs/ change.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VENDOR_ROOT = join(__dirname, "..", "vendor");

const CONDITIONAL = (pkg, name) => `'use strict';

if (process.env.NODE_ENV === 'production') {
  module.exports = require('./cjs/${pkg}-${name}.production.js');
} else {
  module.exports = require('./cjs/${pkg}-${name}.development.js');
}
`;

// Named re-export of an explicit symbol list, so cjs-module-lexer (and thus
// Node's ESM named-import interop) can see the exports statically. Each build
// provides whichever symbols it has (the rest are undefined), so one list can
// span the stable/experimental naming differences (`prerender` vs
// `unstable_prerender`).
const NAMED = (pkg, name, exportsList) => `'use strict';

var s;
if (process.env.NODE_ENV === 'production') {
  s = require('./cjs/${pkg}-${name}.production.js');
} else {
  s = require('./cjs/${pkg}-${name}.development.js');
}

${exportsList.map((e) => `exports.${e} = s.${e};`).join("\n")}
`;

const THROW_NOT_RSC = `'use strict';

throw new Error(
  'The React Server Writer cannot be used outside a react-server environment. ' +
    'You must configure Node.js using the \`--conditions react-server\` flag.'
);
`;

// ---------------------------------------------------------------------------
// react-server-dom-esm — the dev transport (real modules, live import)
// ---------------------------------------------------------------------------

const ESM_PKG = "react-server-dom-esm";

const SERVER_EXPORTS = [
  "renderToPipeableStream",
  // Static prerender. Stable React exposes `prerenderToNodeStream`; the
  // experimental channel still uses `unstable_prerenderToNodeStream`. Surface
  // both — each build provides whichever it has (the other is undefined), so a
  // consumer can `prerenderToNodeStream ?? unstable_prerenderToNodeStream`.
  "prerenderToNodeStream",
  "unstable_prerenderToNodeStream",
  "decodeReplyFromBusboy",
  "decodeReply",
  "decodeAction",
  "decodeFormState",
  "registerServerReference",
  "registerClientReference",
  "createTemporaryReferenceSet",
];

// Edge (Web-streams) server surface. Mirrors the node server shim but exposes
// the Web-standard entry points from react-flight-dom-server.edge:
// renderToReadableStream (instead of renderToPipeableStream) and prerender
// (instead of prerenderToNodeStream), with no Busboy decoder. This is what an
// edge/worker runtime (and vprs's Web (Request)=>Response handler) consumes.
const EDGE_EXPORTS = [
  "renderToReadableStream",
  "prerender",
  "decodeReply",
  "decodeReplyFromAsyncIterable",
  "decodeAction",
  "decodeFormState",
  "registerServerReference",
  "registerClientReference",
  "createTemporaryReferenceSet",
];

// ESM re-export of the server surface, for hosts that import the transport as
// ESM (a Vite/ESM environment) rather than via the CJS conditional shim. Thin
// wrapper over the root `server.node.js` shim — same exports, ESM shape.
const ESM_SERVER = `import mod from "../server.node.js";
export const {
${SERVER_EXPORTS.map((e) => `  ${e},`).join("\n")}
} = mod;
export default mod;
`;

// ESM re-export of the edge server surface (thin wrapper over server.edge.js).
const ESM_EDGE = `import mod from "../server.edge.js";
export const {
${EDGE_EXPORTS.map((e) => `  ${e},`).join("\n")}
} = mod;
export default mod;
`;

const ESM_SHIMS = {
  "index.js": `'use strict';

throw new Error('Use react-server-dom-esm/client instead.');
`,
  "client.js": `'use strict';

module.exports = require('./client.browser');
`,
  "client.browser.js": CONDITIONAL(ESM_PKG, "client.browser"),
  "client.node.js": CONDITIONAL(ESM_PKG, "client.node"),
  // Edge client: the browser client is already Web-ReadableStream/fetch based,
  // so it runs unchanged on edge/worker runtimes — alias it.
  "client.edge.js": `'use strict';

module.exports = require('./client.browser');
`,
  "server.js": THROW_NOT_RSC,
  "server.node.js": NAMED(ESM_PKG, "server.node", SERVER_EXPORTS),
  "server.edge.js": NAMED(ESM_PKG, "server.edge", EDGE_EXPORTS),
  "static.js": THROW_NOT_RSC,
  "static.node.js": NAMED(ESM_PKG, "server.node", SERVER_EXPORTS),
  // Edge static prerender lives in the edge server bundle (prerender →
  // ReadableStream). Surface it under static.edge for parity with the node side.
  "static.edge.js": NAMED(ESM_PKG, "server.edge", EDGE_EXPORTS),
  // ESM server entries, for importing the transport as ESM.
  "esm/react-server-dom-esm-server.node.js": ESM_SERVER,
  "esm/react-server-dom-esm-server.js": ESM_SERVER,
  "esm/react-server-dom-esm-server.edge.js": ESM_EDGE,
};

// ---------------------------------------------------------------------------
// react-server-dom-webpack — the prod transport (module-map references)
// ---------------------------------------------------------------------------

const WEBPACK_PKG = "react-server-dom-webpack";

// Symbol lists mirror React's source shims (packages/react-server-dom-webpack/
// server.*.js / static.*.js), plus the stable/experimental prerender aliases.
const WEBPACK_SERVER_NODE_EXPORTS = [
  "renderToPipeableStream",
  "renderToReadableStream",
  "decodeReply",
  "decodeReplyFromBusboy",
  "decodeReplyFromAsyncIterable",
  "decodeAction",
  "decodeFormState",
  "registerServerReference",
  "registerClientReference",
  "createClientModuleProxy",
  "createTemporaryReferenceSet",
];

const WEBPACK_SERVER_EDGE_EXPORTS = [
  "renderToReadableStream",
  "decodeReply",
  "decodeReplyFromAsyncIterable",
  "decodeAction",
  "decodeFormState",
  "registerServerReference",
  "registerClientReference",
  "createClientModuleProxy",
  "createTemporaryReferenceSet",
];

const WEBPACK_SERVER_BROWSER_EXPORTS = [
  "renderToReadableStream",
  "decodeReply",
  "decodeAction",
  "decodeFormState",
  "registerServerReference",
  "registerClientReference",
  "createClientModuleProxy",
  "createTemporaryReferenceSet",
];

const WEBPACK_STATIC_NODE_EXPORTS = [
  "prerender",
  "unstable_prerender",
  "prerenderToNodeStream",
  "unstable_prerenderToNodeStream",
];

const WEBPACK_STATIC_EDGE_EXPORTS = ["prerender", "unstable_prerender"];

const WEBPACK_SHIMS = {
  "index.js": `'use strict';

throw new Error('Use react-server-dom-webpack/client instead.');
`,
  "client.js": `'use strict';

module.exports = require('./client.browser');
`,
  "client.browser.js": CONDITIONAL(WEBPACK_PKG, "client.browser"),
  "client.node.js": CONDITIONAL(WEBPACK_PKG, "client.node"),
  // Unlike the esm transport, webpack ships a REAL edge client bundle (its
  // client.edge decodes with a serverConsumerManifest — the in-process HTML
  // decode path), so this is a conditional require, not a browser alias.
  "client.edge.js": CONDITIONAL(WEBPACK_PKG, "client.edge"),
  "server.js": THROW_NOT_RSC,
  "server.node.js": NAMED(WEBPACK_PKG, "server.node", WEBPACK_SERVER_NODE_EXPORTS),
  "server.edge.js": NAMED(WEBPACK_PKG, "server.edge", WEBPACK_SERVER_EDGE_EXPORTS),
  "server.browser.js": NAMED(WEBPACK_PKG, "server.browser", WEBPACK_SERVER_BROWSER_EXPORTS),
  "static.js": THROW_NOT_RSC,
  // Static prerender lives in the matching server bundle.
  "static.node.js": NAMED(WEBPACK_PKG, "server.node", WEBPACK_STATIC_NODE_EXPORTS),
  "static.edge.js": NAMED(WEBPACK_PKG, "server.edge", WEBPACK_STATIC_EDGE_EXPORTS),
  "static.browser.js": NAMED(WEBPACK_PKG, "server.browser", WEBPACK_STATIC_EDGE_EXPORTS),
};

// ---------------------------------------------------------------------------

async function writeShims(pkgDirName, shims) {
  const vendorDir = join(VENDOR_ROOT, pkgDirName);
  for (const [name, contents] of Object.entries(shims)) {
    const out = join(vendorDir, name);
    // Some shims live under esm/, which only exists in the build output when an
    // ESM bundle (e.g. the node-loader) was emitted. Create parent dirs so the
    // ESM shims write regardless of which bundles the channel produced.
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, contents);
    console.log(`  ✓ ${pkgDirName}/${name}`);
  }
}

await writeShims(ESM_PKG, ESM_SHIMS);
await writeShims(WEBPACK_PKG, WEBPACK_SHIMS);

// Patch each vendored package.json exports map: the source maps point
// "./server" / "./static" default at throwing entries; the publishable maps
// point them at the node shims. Source-only entries ("./src/*") and pruned
// webpack-consumer artifacts ("./plugin", "./node-register", "./node-loader")
// are dropped.
async function patchPkg(pkgDirName, patch) {
  const pkgPath = join(VENDOR_ROOT, pkgDirName, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  patch(pkg);
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`  ✓ ${pkgDirName}/package.json (exports map rewritten)`);
}

function repointThrowingDefaults(pkg) {
  for (const [entry, target] of [
    ["./server", "./server.node.js"],
    ["./static", "./static.node.js"],
  ]) {
    const value = pkg.exports?.[entry];
    if (value && typeof value === "object" && value.default === `${entry}.js`) {
      value.default = target;
    }
  }
  delete pkg.exports?.["./src/*"];
}

await patchPkg(ESM_PKG, (pkg) => {
  repointThrowingDefaults(pkg);

  // Expose the edge (Web-streams) entry points. vprs (and any consumer)
  // selects these explicitly by specifier, mirroring how it picks client.node vs
  // client.browser per target — no reliance on runtime export conditions.
  if (pkg.exports) {
    pkg.exports["./server.edge"] = "./server.edge.js";
    pkg.exports["./client.edge"] = "./client.edge.js";
    pkg.exports["./static.edge"] = "./static.edge.js";
    // Let edge/worker runtimes resolve the bare ./client to the (Web-based)
    // browser client instead of the node client.
    if (pkg.exports["./client"] && typeof pkg.exports["./client"] === "object") {
      pkg.exports["./client"] = {
        workerd: "./client.browser.js",
        "edge-light": "./client.browser.js",
        deno: "./client.browser.js",
        ...pkg.exports["./client"],
      };
    }
  }
});

await patchPkg(WEBPACK_PKG, (pkg) => {
  repointThrowingDefaults(pkg);
  // Pruned by build-rsl.sh: webpack-consumer artifacts rsl doesn't serve.
  delete pkg.exports?.["./plugin"];
  delete pkg.exports?.["./node-register"];
  delete pkg.exports?.["./node-loader"];
  if (Array.isArray(pkg.files)) {
    pkg.files = pkg.files.filter(
      (f) => !["plugin.js", "node-register.js"].includes(f)
    );
  }
});
