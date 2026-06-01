// Minimal options surface for the directive engine.
//
// vprs ships a richer `DirectiveOptions` shape that pulls from its
// `TransformOptions` / `LoaderConfig` types — those carry build-orchestration
// concerns (panic thresholds, server/client function detection, etc.) that
// aren't part of the directive-engine contract. This package keeps the
// surface to what the engine actually reads from `options`:
//
//   - `verbose` flag — gates a few logger.info calls in analyzeModule.
//   - `logger` — minimal Logger interface (info/warn/error). Defaults to a
//     no-op so callers don't need to wire up Vite's logger or a console fork
//     just to use the engine.
//   - `loader.parse` — optional parser override (defaults to the package's
//     built-in acorn parse). vprs's build transformer passes Rollup's
//     `this.parse` here so the engine sees an AST consistent with the rest
//     of the build pipeline.
//   - `loader.getDirectiveType` — optional mapping from directive string to
//     "client" | "server". Defaults to the React-RSC mapping.

import type { Program } from "./types.js";

export interface Logger {
  info(msg: string, options?: unknown): void;
  warn(msg: string, options?: unknown): void;
  error(msg: string, options?: unknown): void;
}

export type ParseFn = (
  source: string,
  options?: { allowReturnOutsideFunction?: boolean; jsx?: boolean }
) => Program | { ast: Program } | Promise<Program | { ast: Program }>;

export type GetDirectiveTypeFn = (
  directive: string,
  moduleId?: string
) => "client" | "server" | undefined;

export interface DirectiveOptions {
  verbose?: boolean;
  logger?: Logger;
  loader?: {
    parse?: ParseFn;
    getDirectiveType?: GetDirectiveTypeFn;
  };
}

/** No-op logger — silences output unless the caller wires one in. */
export const NULL_LOGGER: Logger = {
  info() {},
  warn() {},
  error() {},
};

/**
 * Console-based logger — what the transformer primitives use by default.
 * Mirrors the shape of Vite's `createLogger()` so vprs-style transformer
 * tests that spy on `console.log` keep matching.
 */
export const CONSOLE_LOGGER: Logger = {
  info(msg: string) {
    console.log(msg);
  },
  warn(msg: string) {
    console.warn(msg);
  },
  error(msg: string) {
    console.error(msg);
  },
};

/** Default directive-type mapping for React Server Components. */
export const defaultGetDirectiveType: GetDirectiveTypeFn = (directive) => {
  if (directive === "use server") return "server";
  if (directive === "use client") return "client";
  return undefined;
};

/** Panic threshold for handleError-style escalation. */
export type PanicThreshold = "none" | "critical_errors" | "all_errors";
