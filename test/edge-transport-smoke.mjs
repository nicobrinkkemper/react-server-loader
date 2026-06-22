// Edge transport conformance smoke — run under the react-server condition:
//   node --conditions=react-server test/edge-transport-smoke.mjs   (npm run test:transport:edge)
//
// Edge counterpart of transport-smoke.mjs. Proves the vendored
// react-server-dom-esm EDGE transport delivers its headline claim: it loads
// with the matched React and renders a server-component tree to an RSC payload
// over a Web `ReadableStream` through react-server-loader/server.edge — the
// shape an edge/worker runtime (and vprs's Web (Request)=>Response handler)
// consumes. A full server->client decode round-trip is the dual-runtime case
// covered by the framework integration (vprs), not here.
import assert from "node:assert/strict";
import React from "react";
import * as serverEdge from "react-server-loader/server.edge";

// 1. The documented /server.edge surface is present.
for (const sym of [
  "renderToReadableStream",
  "registerClientReference",
  "registerServerReference",
  "decodeReply",
  "createTemporaryReferenceSet",
]) {
  assert.equal(typeof serverEdge[sym], "function", `/server.edge must export ${sym}`);
}

// 2. It renders a tree to a non-empty RSC payload over a Web ReadableStream.
const tree = React.createElement(
  "div",
  { id: "root" },
  React.createElement("h1", null, "hello from edge rsc")
);

const stream = serverEdge.renderToReadableStream(tree, "/");
assert.ok(typeof stream.getReader === "function", "must return a Web ReadableStream");

const reader = stream.getReader();
const chunks = [];
const timeout = setTimeout(() => {
  console.error("edge transport smoke timed out waiting for the RSC stream");
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
  payload.includes("hello from edge rsc"),
  "RSC payload should encode the rendered text"
);

console.log(
  `OK edge transport smoke: react ${React.version} -> ${chunks.length} chunk(s), ${payload.length} bytes`
);
console.log("payload head:", JSON.stringify(payload.slice(0, 160)));
