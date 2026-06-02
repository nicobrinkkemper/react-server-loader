// Transport conformance smoke — run under the react-server condition:
//   node --conditions=react-server test/transport-smoke.mjs   (npm run test:transport)
//
// Proves the vendored react-server-dom-esm transport delivers its headline
// claim: it loads with the matched React (devDep, === the vendored version)
// and renders a server-component tree to an RSC payload through
// react-server-loader/server. A full server->client decode round-trip is the
// RSC dual-runtime case covered by the framework integration (vprs), not here.
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import React from "react";
import * as server from "react-server-loader/server";

// 1. The documented /server surface is present.
for (const sym of [
  "renderToPipeableStream",
  "registerClientReference",
  "registerServerReference",
  "decodeReply",
  "createTemporaryReferenceSet",
]) {
  assert.equal(typeof server[sym], "function", `/server must export ${sym}`);
}

// 2. It actually renders a tree to a non-empty RSC payload.
const tree = React.createElement(
  "div",
  { id: "root" },
  React.createElement("h1", null, "hello from rsc")
);

const chunks = [];
const sink = new Writable({
  write(chunk, _enc, cb) {
    chunks.push(chunk);
    cb();
  },
});

const timeout = setTimeout(() => {
  console.error("transport smoke timed out waiting for the RSC stream");
  process.exit(1);
}, 10_000);

await new Promise((resolve, reject) => {
  sink.on("finish", resolve);
  sink.on("error", reject);
  const { pipe } = server.renderToPipeableStream(tree, "/");
  pipe(sink);
});
clearTimeout(timeout);

const payload = Buffer.concat(chunks).toString("utf8");
assert.ok(payload.length > 0, "RSC payload must be non-empty");
assert.ok(
  payload.includes("hello from rsc"),
  "RSC payload should encode the rendered text"
);

console.log(
  `OK transport smoke: react ${React.version} -> ${chunks.length} chunk(s), ${payload.length} bytes`
);
console.log("payload head:", JSON.stringify(payload.slice(0, 160)));
