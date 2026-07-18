// Webpack EDGE transport conformance smoke — run under the react-server condition:
//   node --conditions=react-server test/webpack-edge-transport-smoke.mjs   (npm run test:transport:webpack:edge)
//
// Edge counterpart of webpack-transport-smoke.mjs. Proves the vendored
// react-server-dom-webpack EDGE transport loads with the matched React and
// renders a server-component tree — with a client reference resolved through a
// hand-written module map — to an RSC payload over a Web `ReadableStream`
// through react-server-loader/webpack/server.edge. This is the flight side of
// the baked-bundle prod path (its decode side is webpack/client.edge with a
// serverConsumerManifest, a dual-runtime case covered by the framework
// integration, not here).
import assert from "node:assert/strict";
import React from "react";
import * as serverEdge from "react-server-loader/webpack/server.edge";

// 1. The documented /webpack/server.edge surface is present.
for (const sym of [
  "renderToReadableStream",
  "registerClientReference",
  "registerServerReference",
  "decodeReply",
  "createClientModuleProxy",
  "createTemporaryReferenceSet",
]) {
  assert.equal(
    typeof serverEdge[sym],
    "function",
    `/webpack/server.edge must export ${sym}`
  );
}

// 2. It renders a tree with a module-map-resolved client reference to a
// non-empty RSC payload over a Web ReadableStream.
function ButtonProxy() {}
const Button = serverEdge.registerClientReference(
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
  React.createElement("h1", null, "hello from webpack edge rsc"),
  React.createElement(Button, { label: "click" })
);

const stream = serverEdge.renderToReadableStream(tree, clientManifest);
assert.ok(typeof stream.getReader === "function", "must return a Web ReadableStream");

const reader = stream.getReader();
const chunks = [];
const timeout = setTimeout(() => {
  console.error("webpack edge transport smoke timed out waiting for the RSC stream");
  process.exit(1);
}, 10_000);
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  if (value) chunks.push(Buffer.from(value));
}
clearTimeout(timeout);

const payload = Buffer.concat(chunks).toString("utf8");
assert.ok(payload.length > 0, "RSC payload must be non-empty");
assert.ok(
  payload.includes("hello from webpack edge rsc"),
  "RSC payload should encode the rendered text"
);
assert.ok(
  payload.includes("./assets/Button-abc123.js"),
  "RSC payload should encode the client reference via the module map's id"
);

console.log(
  `OK webpack edge transport smoke: react ${React.version} -> ${chunks.length} chunk(s), ${payload.length} bytes`
);
console.log("payload head:", JSON.stringify(payload.slice(0, 160)));
