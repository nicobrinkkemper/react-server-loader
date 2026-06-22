// Generate the publishable shim entry points for the vendored
// react-server-dom-esm.
//
// React's source-tree shim files (in packages/react-server-dom-esm/) are
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
const VENDOR_DIR = join(__dirname, "..", "vendor", "react-server-dom-esm");

const CONDITIONAL = (name) => `'use strict';

if (process.env.NODE_ENV === 'production') {
  module.exports = require('./cjs/react-server-dom-esm-${name}.production.js');
} else {
  module.exports = require('./cjs/react-server-dom-esm-${name}.development.js');
}
`;

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

const NAMED_SERVER = (name) => `'use strict';

var s;
if (process.env.NODE_ENV === 'production') {
  s = require('./cjs/react-server-dom-esm-${name}.production.js');
} else {
  s = require('./cjs/react-server-dom-esm-${name}.development.js');
}

${SERVER_EXPORTS.map((e) => `exports.${e} = s.${e};`).join("\n")}
`;

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

const NAMED_EDGE = (name) => `'use strict';

var s;
if (process.env.NODE_ENV === 'production') {
  s = require('./cjs/react-server-dom-esm-${name}.production.js');
} else {
  s = require('./cjs/react-server-dom-esm-${name}.development.js');
}

${EDGE_EXPORTS.map((e) => `exports.${e} = s.${e};`).join("\n")}
`;

const THROW_NOT_RSC = `'use strict';

throw new Error(
  'The React Server Writer cannot be used outside a react-server environment. ' +
    'You must configure Node.js using the \`--conditions react-server\` flag.'
);
`;

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

const SHIMS = {
  "index.js": `'use strict';

throw new Error('Use react-server-dom-esm/client instead.');
`,
  "client.js": `'use strict';

module.exports = require('./client.browser');
`,
  "client.browser.js": CONDITIONAL("client.browser"),
  "client.node.js": CONDITIONAL("client.node"),
  // Edge client: the browser client is already Web-ReadableStream/fetch based,
  // so it runs unchanged on edge/worker runtimes — alias it.
  "client.edge.js": `'use strict';

module.exports = require('./client.browser');
`,
  "server.js": THROW_NOT_RSC,
  "server.node.js": NAMED_SERVER("server.node"),
  "server.edge.js": NAMED_EDGE("server.edge"),
  "static.js": THROW_NOT_RSC,
  "static.node.js": NAMED_SERVER("server.node"),
  // Edge static prerender lives in the edge server bundle (prerender →
  // ReadableStream). Surface it under static.edge for parity with the node side.
  "static.edge.js": NAMED_EDGE("server.edge"),
  // ESM server entries, for importing the transport as ESM.
  "esm/react-server-dom-esm-server.node.js": ESM_SERVER,
  "esm/react-server-dom-esm-server.js": ESM_SERVER,
  "esm/react-server-dom-esm-server.edge.js": ESM_EDGE,
};

for (const [name, contents] of Object.entries(SHIMS)) {
  const out = join(VENDOR_DIR, name);
  // Some shims live under esm/, which only exists in the build output when an
  // ESM bundle (e.g. the node-loader) was emitted. Create parent dirs so the
  // ESM shims write regardless of which bundles the channel produced.
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, contents);
  console.log(`  ✓ ${name}`);
}

// Patch the package.json exports map: the source map points "./server"
// default at "./server.js" (which throws when not in react-server
// condition). The publishable map points it at "./server.node.js". Same
// for "./static". And the source map has a "./src/*" entry that's not
// applicable to the vendored package.
const pkgPath = join(VENDOR_DIR, "package.json");
const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
if (pkg.exports?.["./server"]?.default === "./server.js") {
  pkg.exports["./server"].default = "./server.node.js";
}
if (pkg.exports?.["./static"]?.default === "./static.js") {
  pkg.exports["./static"].default = "./static.node.js";
}
delete pkg.exports?.["./src/*"];

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
await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log("  ✓ package.json (exports map rewritten)");
