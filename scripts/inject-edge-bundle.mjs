// Inject the react-server-dom-esm EDGE (Web-streams) server bundle into a React
// checkout's build config, so React's rollup emits
// react-server-dom-esm-server.edge.{development,production}.js alongside the
// node server bundle.
//
// The ESM transport CAN run on an edge (Web-streams) server — React even has
// the edge server source shape — but upstream never wired an edge build for it
// the way webpack/parcel/turbopack are wired. Making React emit
// react-server-dom-esm-server.edge.* needs FOUR things that upstream lacks:
//   A. packages/react-server-dom-esm/src/server/ReactFlightDOMServerEdge.js     (source)
//   B. packages/react-server-dom-esm/src/server/react-flight-dom-server.edge.js (bundle shim)
//   C. packages/react-client/src/forks/ReactFlightClientConfig.dom-edge-esm.js  (client fork)
//   D. packages/react-server/src/forks/ReactFlightServerConfig.dom-edge-esm.js  (server fork)
//      + scripts/rollup/bundles.js            (edge bundle entry)
//      + scripts/shared/inlinedHostConfigs.js (dom-edge-esm host-config block)
// A–D are carried in this repo under scripts/react-edge-patch/ (mirroring the
// React packages/ layout) and OVERLAID onto the checkout here; the two scripts/
// files are patched in place. All steps are idempotent. build-rsl.sh runs this
// AFTER the forced `git checkout` (which restores tracked files to pristine and
// leaves our untracked overlay), so the wiring is re-applied on every build and
// never committed to the React checkout.
//
// Usage: node scripts/inject-edge-bundle.mjs [reactDir]
//   reactDir defaults to $REACT_DIR, then the sibling ../react.

import { readFile, writeFile, access, cp, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REACT_DIR =
  process.argv[2] ||
  process.env.REACT_DIR ||
  join(__dirname, "..", "..", "react");
const PATCH_DIR = join(__dirname, "react-edge-patch");

const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

// ---- 1. rollup bundle entry -------------------------------------------------
const BUNDLES = join(REACT_DIR, "scripts/rollup/bundles.js");
const BUNDLE_ENTRY = `  /******* React Server DOM ESM Server (Edge / Web streams) *******/
  {
    bundleTypes: [NODE_DEV, NODE_PROD],
    moduleType: RENDERER,
    entry: 'react-server-dom-esm/src/server/react-flight-dom-server.edge',
    name: 'react-server-dom-esm-server.edge',
    condition: 'react-server',
    global: 'ReactServerDOMServer',
    minifyWithProdErrorCodes: false,
    wrapWithModuleBoundaries: false,
    externals: ['react', 'react-dom'],
  },

`;
const BUNDLE_MARKER = "  /******* React Server DOM ESM Client *******/";

// ---- 2. inlined host config block ------------------------------------------
const HOSTCONFIGS = join(REACT_DIR, "scripts/shared/inlinedHostConfigs.js");
const HOST_BLOCK = `  {
    shortName: 'dom-edge-esm',
    entryPoints: [
      'react-server-dom-esm/src/server/react-flight-dom-server.edge',
    ],
    paths: [
      'react-dom',
      'react-dom/src/ReactDOMReactServer.js',
      'react-dom-bindings',
      'react-dom/client',
      'react-dom/profiling',
      'react-dom/server.edge',
      'react-dom/static.edge',
      'react-dom/unstable_testing',
      'react-dom/src/server/react-dom-server.edge',
      'react-dom/src/server/ReactDOMFizzServerEdge.js', // react-dom/server.edge
      'react-dom/src/server/ReactDOMFizzStaticEdge.js',
      'react-dom-bindings/src/server/ReactDOMFlightServerHostDispatcher.js',
      'react-dom-bindings/src/server/ReactFlightServerConfigDOM.js',
      'react-dom-bindings/src/shared/ReactFlightClientConfigDOM.js',
      'react-server-dom-esm',
      'react-server-dom-esm/server.edge',
      'react-server-dom-esm/static.edge',
      'react-server-dom-esm/src/server/react-flight-dom-server.edge',
      'react-server-dom-esm/src/server/ReactFlightDOMServerEdge.js', // react-server-dom-esm/src/server/react-flight-dom-server.edge
      'react-devtools',
      'react-devtools-core',
      'react-devtools-shell',
      'react-devtools-shared',
      'shared/ReactDOMSharedInternals',
      'react-server/src/ReactFlightServerConfigDebugNoop.js',
    ],
    isFlowTyped: true,
    isServerSupported: true,
  },
`;
const HOST_MARKER = "  {\n    shortName: 'dom-node-esm',";

async function patch(file, marker, insert, sentinel) {
  if (!(await exists(file))) {
    throw new Error(`not found: ${file}`);
  }
  let s = await readFile(file, "utf8");
  if (s.includes(sentinel)) {
    console.log(`  • ${file.replace(REACT_DIR + "/", "")} — already patched`);
    return;
  }
  if (!s.includes(marker)) {
    throw new Error(`anchor not found in ${file}: ${JSON.stringify(marker)}`);
  }
  s = s.replace(marker, insert + marker);
  await writeFile(file, s);
  console.log(`  ✓ ${file.replace(REACT_DIR + "/", "")} — patched`);
}

// Recursively list files under a dir, relative to it.
async function listFiles(dir, base = dir) {
  const out = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await listFiles(full, base)));
    else out.push(relative(base, full));
  }
  return out;
}

if (!(await exists(PATCH_DIR))) {
  throw new Error(`carried patch dir missing: ${PATCH_DIR}`);
}
if (!(await exists(join(REACT_DIR, "packages")))) {
  throw new Error(`not a React checkout (no packages/): ${REACT_DIR}`);
}

console.log(`Injecting esm edge bundle into ${REACT_DIR} ...`);

// 0. Overlay carried source + fork files onto the checkout's packages/.
for (const rel of await listFiles(PATCH_DIR)) {
  await cp(join(PATCH_DIR, rel), join(REACT_DIR, "packages", rel));
  console.log(`  ✓ packages/${rel} — overlaid`);
}

// 1+2. Patch the build config files in place.
await patch(BUNDLES, BUNDLE_MARKER, BUNDLE_ENTRY, "react-server-dom-esm-server.edge");
await patch(HOSTCONFIGS, HOST_MARKER, HOST_BLOCK, "dom-edge-esm");
console.log("done.");
