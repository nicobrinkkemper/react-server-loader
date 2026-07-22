// Webpack runtime smoke, step 1 of 2 — plain node (client side):
//   node test/webpack-runtime-encode.mjs
//
// Exercises createWebpackClient (install-then-load ordering owned by the
// factory) against the REAL vendored transport, and encodes an action reply
// carrying a server reference — the FormData-shaped body the server step
// decodes through the gate-backed runtime. Run via:
//   npm run test:transport:webpack:runtime
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import {
  createWebpackClient,
  installWebpackGlobals,
} from "react-server-loader/webpack/runtime";

// Shared contract with step 2 (webpack-runtime-smoke.mjs).
export const ACTION_ID = "/assets/actions-Bv7pQm1Z.js#increment";

// The edge build specifically (this runs under plain node, whose conditions
// would resolve the node build): install globals first, then import — the
// same install-then-load ordering createWebpackClient owns for the
// environment-resolved path.
installWebpackGlobals({});
const clientMod = await import("react-server-loader/webpack/client.edge");
const client = clientMod.default ?? clientMod;

// The factory itself, under plain node: the environment-resolved import must
// hand back the NODE build (createFromNodeStream is node-only surface) — the
// direct proof that resolve conditions, not an option, pick the variant. Also
// keeps the factory's install-then-load ordering exercised at all.
const envClient = await createWebpackClient({});
assert.equal(
  typeof envClient.createFromNodeStream,
  "function",
  "under node conditions the factory must return the node build"
);
for (const sym of ["createServerReference", "encodeReply", "createFromReadableStream"]) {
  assert.equal(typeof client[sym], "function", `client surface must expose ${sym}`);
}

const ref = client.createServerReference(ACTION_ID, async () => {
  throw new Error("callServer must not run during encodeReply");
});
const body = await client.encodeReply([ref, 41]);

// A server-reference argument forces the FormData encoding; flatten for the
// separate server process.
const raw =
  typeof body === "string"
    ? { kind: "string", data: body }
    : { kind: "form", data: [...body.entries()] };
await writeFile(new URL("./.tmp-webpack-runtime-reply.json", import.meta.url), JSON.stringify(raw));
console.log(`OK runtime encode: ${raw.kind} reply written (explicit client.edge import)`);
