// Node-runtime env helpers used by the transformer primitives.
//
// Ported from vprs's `plugin/config/getNodeEnv.ts`. Kept minimal — no
// build-config concerns, just "what mode is this Node process running in?".

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
 * `react-server` condition (`--conditions react-server` on the command line,
 * or NODE_OPTIONS containing the same). Mirrors vprs's getCondition.
 */
export function isReactServerCondition(): boolean {
  const argv = process.execArgv?.join(" ") ?? "";
  const nodeOpts = process.env["NODE_OPTIONS"] ?? "";
  return (argv + " " + nodeOpts).includes("react-server");
}
