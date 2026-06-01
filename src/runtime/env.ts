// Node-runtime helpers shared across the transformer primitives.
//
// Intentionally small: just enough to answer "what mode is this Node
// process running in?" and "is the `react-server` resolution condition
// active?". A host that already has richer runtime introspection (a
// build tool, a framework) can ignore these and pass concrete values
// through the loader / transformer options instead.

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace NodeJS {
    interface ProcessEnv {
      NODE_ENV: "development" | "test" | "production";
    }
  }
}

export const validEnvs = ["development", "test", "production"] as const;
export type NodeEnv = (typeof validEnvs)[number];

export const isValidEnv = (env: string): env is NodeEnv =>
  (validEnvs as readonly string[]).includes(env);

export function getNodeEnv<E extends string = NodeEnv>(
  currentEnv: E = (process.env["NODE_ENV"] as E) ?? ("development" as E)
): NodeEnv {
  return isValidEnv(currentEnv) ? currentEnv : "development";
}

/**
 * Detects whether the current Node process is running under the
 * `react-server` resolution condition — set with `--conditions react-server`
 * on the command line, or via `NODE_OPTIONS` containing the same flag.
 *
 * Servers rendering React Server Components run under this condition so
 * that `react` and `react-server-dom-esm` resolve to their server-side
 * exports.
 */
export function isReactServerCondition(): boolean {
  const argv = process.execArgv?.join(" ") ?? "";
  const nodeOpts = process.env["NODE_OPTIONS"] ?? "";
  return (argv + " " + nodeOpts).includes("react-server");
}
