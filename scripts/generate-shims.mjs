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

import { readFile, writeFile } from "node:fs/promises";
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

const THROW_NOT_RSC = `'use strict';

throw new Error(
  'The React Server Writer cannot be used outside a react-server environment. ' +
    'You must configure Node.js using the \`--conditions react-server\` flag.'
);
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
  "server.js": THROW_NOT_RSC,
  "server.node.js": NAMED_SERVER("server.node"),
  "static.js": THROW_NOT_RSC,
  "static.node.js": NAMED_SERVER("server.node"),
};

for (const [name, contents] of Object.entries(SHIMS)) {
  await writeFile(join(VENDOR_DIR, name), contents);
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
await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log("  ✓ package.json (exports map rewritten)");
