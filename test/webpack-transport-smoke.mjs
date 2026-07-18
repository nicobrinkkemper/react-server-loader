// Webpack transport conformance smoke — run under the react-server condition:
//   node --conditions=react-server test/webpack-transport-smoke.mjs   (npm run test:transport:webpack)
//
// Proves the vendored react-server-dom-webpack transport delivers its headline
// claim: it loads with the matched React (devDep, === the vendored version) and
// renders a server-component tree to an RSC payload through
// react-server-loader/webpack/server — including a CLIENT REFERENCE resolved
// through a hand-written module map (the closed-registry model this transport
// exists for, vs the esm transport's import(specifier)). A full server->client
// decode round-trip is the RSC dual-runtime case covered by the framework
// integration (vprs), not here.
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import React from "react";
import * as server from "react-server-loader/webpack/server";

// 1. The documented /webpack/server surface is present.
for (const sym of [
  "renderToPipeableStream",
  "registerClientReference",
  "registerServerReference",
  "decodeReply",
  "createClientModuleProxy",
  "createTemporaryReferenceSet",
]) {
  assert.equal(typeof server[sym], "function", `/webpack/server must export ${sym}`);
}

// 2. It renders a tree — with a client reference resolved through a module
// map — to a non-empty RSC payload. The manifest is keyed by `${id}#${name}`
// and maps to {id, chunks, name}: the webpack-shaped client manifest a bake
// step would emit.
function ButtonProxy() {}
const Button = server.registerClientReference(
  ButtonProxy,
  "src/Button.js",
  "default"
);
const clientManifest = {
  "src/Button.js#default": {
    id: "./assets/Button-abc123.js",
    chunks: [],
    name: "default",
  },
};

const tree = React.createElement(
  "div",
  { id: "root" },
  React.createElement("h1", null, "hello from webpack rsc"),
  React.createElement(Button, { label: "click" })
);

const chunks = [];
const sink = new Writable({
  write(chunk, _enc, cb) {
    chunks.push(chunk);
    cb();
  },
});

const timeout = setTimeout(() => {
  console.error("webpack transport smoke timed out waiting for the RSC stream");
  process.exit(1);
}, 10_000);

await new Promise((resolve, reject) => {
  sink.on("finish", resolve);
  sink.on("error", reject);
  const { pipe } = server.renderToPipeableStream(tree, clientManifest, {
    onError(err) {
      reject(err);
    },
  });
  pipe(sink);
});
clearTimeout(timeout);

const payload = Buffer.concat(chunks).toString("utf8");
assert.ok(payload.length > 0, "RSC payload must be non-empty");
assert.ok(
  payload.includes("hello from webpack rsc"),
  "RSC payload should encode the rendered text"
);
assert.ok(
  payload.includes("./assets/Button-abc123.js"),
  "RSC payload should encode the client reference via the module map's id"
);

console.log(
  `OK webpack transport smoke: react ${React.version} -> ${chunks.length} chunk(s), ${payload.length} bytes`
);
console.log("payload head:", JSON.stringify(payload.slice(0, 160)));
