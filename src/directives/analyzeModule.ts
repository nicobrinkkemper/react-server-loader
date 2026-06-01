import { parse } from "../transformer/parse.js";
import { analyzeDirectives } from "./analyzeDirectives.js";
import { getExports } from "./getExports.js";
import type { ParsedExports, ParseResult, Program } from "./types.js";
import {
  NULL_LOGGER,
  defaultGetDirectiveType,
  type DirectiveOptions,
} from "./options.js";

/**
 * Analyzes a module for directives and returns the parse result with directive info.
 */
export async function analyzeModule(
  source: string,
  options?: DirectiveOptions
): Promise<ParseResult> {
  const {
    verbose = false,
    logger = NULL_LOGGER,
    loader = { parse, getDirectiveType: defaultGetDirectiveType },
  } = options ?? {};
  let result =
    typeof loader.parse === "function"
      ? loader.parse(source)
      : parse(source);
  if (result instanceof Promise) {
    result = await result;
  }
  if (typeof result === "object" && !("ast" in result)) {
    result = {
      ast: result,
    };
  }
  // Collect exports from the AST first. `result` is a `{ ast, ... }` shape
  // by this point; the `exports` field is optional on the parser return type
  // — a bundler that already collected exports while parsing can pass them
  // through, while the package's built-in parse does not. Cast is safe
  // because the read is guarded by `"exports" in result`.
  const resultAny = result as {
    ast: Program;
    exports?: ParsedExports;
    code?: string;
    map?: {
      url: string;
      start: number;
      end: number;
      lines: number;
    } | null;
  };
  const exports: ParsedExports =
    "exports" in resultAny && resultAny.exports
      ? resultAny.exports
      : await getExports(resultAny.ast);

  if (verbose) {
    if (exports && exports.exports.size > 0) {
      logger.info(
        "[analyzeModule] exports:\n" +
          Array.from(exports.exports.values())
            .map((e) => `Name: ${e.exportName} Type: ${e.type} Range: ${e.localName}\n`)
            .join("\n")
      );
    }
  }

  const directiveInfo = analyzeDirectives(result.ast, source, options);
  if (verbose) {
    if (directiveInfo.warnings.length > 0) {
      logger.info("[analyzeModule] warnings:\n" + directiveInfo.warnings.join("\n"));
    }
  }
  const { code = source, map, ast, exports: _, ...rest } = resultAny;
  return {
    type: "success",
    ...rest,
    code: code,
    map: map,
    ast: ast,
    exports,
    directiveInfo,
  };
}
