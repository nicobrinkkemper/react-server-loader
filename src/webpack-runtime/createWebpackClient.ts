// Install-then-load wrapper that makes the eval-order footgun impossible.
//
// The production `client.browser` build reads `__webpack_require__.u` at
// MODULE-EVAL time — a static `import` of the transport hoisted above an
// `installWebpackGlobals(...)` call crashes before the shim exists. This
// factory owns the ordering internally: globals first, transport after, so a
// consumer entry point cannot get it wrong.
import {
  installWebpackGlobals,
  type WebpackGlobalsOptions,
} from "./installWebpackGlobals.js";

export type CreateWebpackClientOptions = WebpackGlobalsOptions;

/**
 * Installs the webpack module-loading globals, then loads the vendored
 * webpack flight client. Returns the client module namespace
 * (`createFromReadableStream`, `createFromFetch`, `createServerReference`,
 * `encodeReply`, …).
 *
 * WHICH client build loads is decided by the ENVIRONMENT, not an option: the
 * `react-server-loader/webpack/client` export maps resolve conditions to the
 * right vendored build (browser default, `node`, and the `workerd` / `deno` /
 * `edge-light` edge family). The previous `target` option enumerated literal
 * imports of every variant, which made bundlers ship all three — a browser
 * bundle carried the Node build (and its `node:util` import) as dead weight.
 * A host that genuinely needs a specific variant imports it explicitly
 * (`react-server-loader/webpack/client.edge`) and calls
 * `installWebpackGlobals` itself.
 */
export async function createWebpackClient(
  options: CreateWebpackClientOptions = {}
): Promise<Record<string, unknown>> {
  installWebpackGlobals(options);
  const mod = (await import(
    "react-server-loader/webpack/client"
  )) as Record<string, unknown>;
  // The vendored shims are CJS; under Node ESM interop the surface may sit on
  // `default`. Normalize so consumers always destructure the same shape.
  const surface = (mod as { default?: Record<string, unknown> }).default ?? mod;
  return { ...surface, ...mod };
}
