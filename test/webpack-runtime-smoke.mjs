// Webpack runtime smoke, step 2 of 2 — react-server condition (server side):
//   node --conditions=react-server test/webpack-runtime-smoke.mjs
//
// The action decode loop through the runtime helpers against the REAL
// vendored transport: a server reference registered via webpack/server.edge,
// the sealed reference gate as the only module source, bridged into
// webpack's globals by installWebpackGlobals + gateModuleLoader, resolved by
// decodeReply(serverModuleMap). This pins, per vendored React build, the
// ordering the bridge depends on: React awaits chunk loads before the sync
// require. Run via:
//   npm run test:transport:webpack:runtime
import assert from "node:assert/strict";
import { readFile, unlink } from "node:fs/promises";
import * as server from "react-server-loader/webpack/server.edge";
import {
  installWebpackGlobals,
  gateModuleLoader,
} from "react-server-loader/webpack/runtime";
import { createReferenceGate } from "react-server-loader/references";

const ACTION_ID = "/assets/actions-Bv7pQm1Z.js#increment";
const [MODULE_ID, EXPORT_NAME] = ACTION_ID.split("#");

// The action module as the server bundle holds it: registered reference.
async function increment(n) {
  return n + 1;
}
server.registerServerReference(increment, MODULE_ID, EXPORT_NAME);

const gate = createReferenceGate({ mode: "sealed" });
gate.register({
  id: MODULE_ID,
  load: async () => ({ [EXPORT_NAME]: increment }),
  kind: "server",
  exportNames: [EXPORT_NAME],
});
gate.seal();

installWebpackGlobals({ load: gateModuleLoader(gate) });

const serverModuleMap = {
  [ACTION_ID]: { id: MODULE_ID, chunks: [ACTION_ID], name: EXPORT_NAME },
};

const replyPath = new URL("./.tmp-webpack-runtime-reply.json", import.meta.url);
const raw = JSON.parse(await readFile(replyPath, "utf8"));
let body;
if (raw.kind === "form") {
  body = new FormData();
  for (const [k, v] of raw.data) body.append(k, v);
} else {
  body = raw.data;
}

const [fn, n] = await server.decodeReply(body, serverModuleMap);
const result = await fn(n);
assert.equal(result, 42, `increment(${n}) must be 42 through the gate-backed runtime`);

// Negative: outside the sealed set nothing resolves.
await assert.rejects(
  globalThis.__webpack_chunk_load__("/assets/evil-XXXXXXXX.js#pwn"),
  /no registry or loader/,
  "an unregistered id must not chunk-load"
);

await unlink(replyPath);
console.log(
  `OK webpack runtime smoke: gate-backed decodeReply resolved ${ACTION_ID}, increment(${n}) = ${result}; unregistered id refused`
);
