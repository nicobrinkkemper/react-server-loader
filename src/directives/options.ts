// Options the directive engine reads at call time.
//
// The directive engine is the smallest reusable piece of the package — a
// pure function set that decides whether a given module source declares a
// React Server Components boundary directive (`"use client"` /
// `"use server"`) and where the directive sits in the AST. The options
// shape mirrors that scope: only the four fields the engine actually
// inspects.
//
//   - `verbose` — gates the `logger.info` calls that trace which module
//     is being analysed. Useful for debugging a misbehaving boundary.
//   - `logger` — a minimal sink (`info` / `warn` / `error`). Defaults to a
//     no-op so the engine stays silent unless a host explicitly wires a
//     backend.
//   - `loader.parse` — supply an AST instead of letting the engine call
//     its built-in acorn parse. A bundler that already has the AST in
//     hand (Rollup, esbuild, swc) can pass `this.parse` here so the
//     engine's classification stays consistent with the rest of the
//     build pipeline.
//   - `loader.getDirectiveType` — map a directive string to
//     `"client" | "server"`. Defaults to React's RSC mapping; override
//     to extend or replace the recognised directive vocabulary.

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
 * `console`-backed logger. Use when you want the engine's verbose trace
 * to print to stdout without wiring a custom backend. Each method maps
 * straight to the matching `console` call so spy-based tests that watch
 * `console.log` / `console.warn` keep working.
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
