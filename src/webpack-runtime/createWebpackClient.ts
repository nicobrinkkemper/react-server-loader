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

export type WebpackClientTarget = "browser" | "edge" | "node";

const CLIENT_ENTRIES: Record<WebpackClientTarget, () => Promise<Record<string, unknown>>> = {
  // Literal specifiers so bundlers can statically include each entry.
  browser: () => import("react-server-loader/webpack/client.browser"),
  edge: () => import("react-server-loader/webpack/client.edge"),
  node: () => import("react-server-loader/webpack/client.node"),
};

export interface CreateWebpackClientOptions extends WebpackGlobalsOptions {
  /** Which vendored client entry to load. Default: `"browser"`. */
  target?: WebpackClientTarget;
}

/**
 * Installs the webpack module-loading globals, then loads the vendored
 * webpack flight client for `target`. Returns the client module namespace
 * (`createFromReadableStream`, `createFromFetch`, `createServerReference`,
 * `encodeReply`, …).
 */
export async function createWebpackClient(
  options: CreateWebpackClientOptions = {}
): Promise<Record<string, unknown>> {
  const { target = "browser", ...globals } = options;
  const entry = CLIENT_ENTRIES[target];
  if (!entry) {
    throw new Error(
      `createWebpackClient: unknown target "${String(target)}" (expected "browser", "edge", or "node")`
    );
  }
  installWebpackGlobals(globals);
  const mod = await entry();
  // The vendored shims are CJS; under Node ESM interop the surface may sit on
  // `default`. Normalize so consumers always destructure the same shape.
  const surface = (mod as { default?: Record<string, unknown> }).default ?? mod;
  return { ...surface, ...mod };
}
