import { analyzeDirectives } from "./analyzeDirectives.js";
import { sourceHasTopLevelClientDirective } from "./sourceHasTopLevelClientDirective.js";
import type { Program } from "acorn";

/**
 * Files whose NAME looks like a client module: the dotted suffix convention
 * (`Foo.client.tsx`) or the standalone basename (`src/client.tsx`).
 *
 * This is NOT a classifier. A filename never makes a module a client module —
 * only a top-of-file `"use client"` directive does, because that is the only
 * signal React itself defines and the only one that travels to another
 * toolchain. A file that relies on a name is not portable: move it to any other
 * React setup and it silently becomes a server module.
 *
 * The pattern survives solely to power a warning ({@link looksLikeClientFilename}),
 * so a project that named a file `.client.tsx` and forgot the directive is told
 * to add it instead of silently getting a server module.
 *
 * The leading `(^|[\/.])` anchor keeps it strict: `clientId.ts`,
 * `clientUtils.tsx`, `src/lib/clientHelpers.ts` do NOT match, because the
 * character before "client" must be start-of-string, a separator, or a dot.
 */
const CLIENT_FILENAME_PATTERN = /(^|[\/.])client\.[cm]?[jt]sx?$/;

/** Modules inside an installed package — never warned about; not our code. */
const PACKAGE_PATH_PATTERN = /(^|[\/\\])node_modules[\/\\]/;

/**
 * True when a FIRST-PARTY file is named like a client module. Callers that have
 * a logger use this to warn when such a file carries no `"use client"`
 * directive. Package files are excluded: a dependency's layout is its own
 * business, and `.client` there routinely means a build-CONDITION variant with
 * no relation to `"use client"`.
 */
export function looksLikeClientFilename(moduleId: string | undefined): boolean {
  if (!moduleId) return false;
  if (PACKAGE_PATH_PATTERN.test(moduleId)) return false;
  return CLIENT_FILENAME_PATTERN.test(moduleId);
}

export type ParseFn = (
  source: string,
  options?: { allowReturnOutsideFunction?: boolean; jsx?: boolean },
) => Program;

export type DetectClientModuleOpts = {
  /** Module source text. If absent or empty, only the filename pattern applies. */
  source?: string;
  /** Module identifier / file path. If absent, only the source check applies. */
  moduleId?: string;
  /**
   * Optional AST producer. When provided (the build's transformer plugin
   * passes Rollup's `this.parse`), the helper parses with JSX/TS awareness
   * and inspects directives via {@link analyzeDirectives}. When omitted
   * (dev-server file watcher, the worker react-loader, the configurable
   * `loader.*` defaults), the helper falls back to the parser-free
   * char-scanner from {@link sourceHasTopLevelClientDirective}. Both paths
   * agree on every well-authored case.
   */
  parseFn?: ParseFn;
};

/**
 * Decides whether a module is a React client component.
 *
 * A module is client if and ONLY IF its source declares a top-of-file
 * `"use client"` directive — leading whitespace, line/block comments, and a
 * `"use strict"` prologue tolerated above it (React's contract).
 *
 * The filename is deliberately NOT a signal. `Foo.client.tsx` with no directive
 * is a server module here, exactly as it is under every other React toolchain;
 * making the name load-bearing would produce files that only work under this
 * loader. Callers with a logger can use {@link looksLikeClientFilename} to warn
 * on that case rather than silently guessing. Substring matches against
 * "client" in identifiers, comments, import paths, or directory names are
 * likewise rejected.
 *
 * Every call site that needs a "is this client?" answer routes through this
 * helper (transformer, worker react-loader, dev-server file watcher, build
 * auto-discover, the configurable `loader.*` defaults in
 * `config/defaults.tsx`), so the answer is the same for the same input at
 * every layer.
 */
export function detectClientModule({
  source,
  moduleId: _moduleId,
  parseFn,
}: DetectClientModuleOpts): boolean {
  // 1. Directive in source. Cheap pre-filter; no occurrence of "use client" →
  //    definitely not a client module, and we avoid both the parse and the
  //    scanner.
  if (!source) return false;
  if (!source.includes("use client")) return false;

  // 2. Prefer the AST path when a parser is available (build transformer).
  if (parseFn) {
    try {
      const ast = parseFn(source, {
        allowReturnOutsideFunction: true,
        jsx: true,
      });
      const directiveInfo = analyzeDirectives(ast, source);
      if (directiveInfo.fileLevel?.type !== "client") return false;
      // analyzeDirectives still records a misplaced `"use client";` (after
      // real code) as a file-level entry but flags it. React's contract
      // requires top-of-file placement, so a flagged one is not real.
      const misplaced = directiveInfo.warnings.some((w) =>
        w.message.includes("must be at the top of the file"),
      );
      return !misplaced;
    } catch {
      // Parse failure → fall through to the parser-free scanner.
    }
  }

  // 3. Parser-free fallback. Same structural contract.
  return sourceHasTopLevelClientDirective(source);
}
