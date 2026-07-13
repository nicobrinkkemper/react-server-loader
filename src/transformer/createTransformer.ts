import { transformModule } from "./transformModule.js";
import { transformNonServerEnvironment } from "./transformNonServerEnvironment.js";
import { isReactServerCondition } from "../runtime/env.js";
import {
  analyzeModule,
  looksLikeClientFilename,
  hasDirectiveStatement,
} from "../directives/index.js";
import { findDirectiveMatches } from "../directives/findDirectiveMatches.js";
import { sourceHasTopLevelClientDirective } from "../directives/sourceHasTopLevelClientDirective.js";
import type { DirectiveMatch } from "../directives/types.js";
import type { TransformerFactory, TransformResult } from "./types.js";
import { DEFAULT_LOADER_CONFIG } from "./defaults.js";
import { getNodeEnv } from "../runtime/env.js";
import { NULL_LOGGER } from "../directives/options.js";
import pkg from "picocolors";
const { red, underline } = pkg;

// Warn once per module: a watch-mode rebuild re-transforms the same file on
// every change, and repeating the advice each time is just noise.
const warnedClientFilename = new Set<string>();

/**
 * Creates a transformer that handles React Server Components (RSC) boundaries.
 */
export const createTransformer: TransformerFactory = ({
  options,
  forceServerFunction = undefined,
  forceClientComponent = undefined,
  isServerEnvironment = isReactServerCondition(),
}) => {
  
  const {
    verbose,
    logger = NULL_LOGGER,
    loader = DEFAULT_LOADER_CONFIG,
    isExternalModule = (id: string) => id.includes("node_modules"),
  } = options;

  // Track if forceServerFunction/forceClientComponent were explicitly passed (for testing)
  // vs auto-detected from directives (for normal builds)
  const explicitForceServerFunction = forceServerFunction !== undefined;
  const explicitForceClientComponent = forceClientComponent !== undefined;
  
  // Save initial values to reset on each call (closure bug fix)
  const initialForceServerFunction = forceServerFunction;
  const initialForceClientComponent = forceClientComponent;

  return async (
    source: string,
    moduleId: string,
    // if a moduleID function is provided, use it to get the transformed module ID by default
    // otherwise, use the original module ID
    // can also be passed directly as a parameter
    transformedModuleId = loader?.moduleID?.(moduleId) ?? moduleId
  ): Promise<TransformResult> => {
    // Reset flags at start of each call to prevent closure state pollution
    // (Each transformation should start fresh, not inherit state from previous calls)
    forceServerFunction = initialForceServerFunction;
    forceClientComponent = initialForceClientComponent;
    
    if (verbose) {
      logger.info(`[createTransformer] moduleID function called: ${moduleId} -> ${transformedModuleId}`);
    }
    if (verbose && moduleId.includes("client")) {
      logger.info(
        `[createTransformer:${
          isServerEnvironment ? "server" : "client"
        }] Loading: ${moduleId}`
      );
    }

    // Fast-path: skip parsing and transformation if no directives are present.
    //
    // `findDirectiveMatches` matches the literal `"use client"` / `"use server"`
    // ANYWHERE — including inside string/template literals, comments, and JSX
    // text (a component that *displays* directive example code). A regex hit
    // alone can't tell a real directive from a quoted occurrence, and a
    // top-of-file scanner can't see a MISPLACED directive (real code before it)
    // that the transform must still flag. So when a hit suggests a directive
    // MIGHT be present, parse once and ask the directive engine, which records a
    // directive only for a real directive STATEMENT, never for a quoted literal.
    //
    // BOTH sides need this. `react-server-dom-esm`'s own client transport throws
    // an error whose message contains the words `"use server"`; taking the regex
    // at its word made the transform treat the transport as a server-action
    // module and inject a `registerServerReference` import into a file that
    // already DEFINES `registerServerReference` — a duplicate-declaration parse
    // error the moment the transport is bundled.
    //
    // Fall back to the regex/scanner only when the source can't be parsed.
    const matches = findDirectiveMatches(source);
    const mayHaveClient = matches.matches.some(
      (m: DirectiveMatch) => m.type === "client"
    );
    const mayHaveServer = matches.matches.some(
      (m: DirectiveMatch) => m.type === "server"
    );

    let hasClientDirective = false;
    let hasServerDirective = false;
    if (mayHaveClient || mayHaveServer) {
      try {
        const pre = await analyzeModule(source, { ...options, logger, loader });
        const info = pre.directiveInfo;
        hasClientDirective = info?.fileLevel?.type === "client";
        // Gate on a real directive STATEMENT anywhere — file prologue or the
        // prologue of ANY function body. `directiveInfo.functionLevel` is not
        // enough: it records top-level functions and arrows, but not class
        // methods or nested declarations, and the downstream transform handles
        // those. Gating on it would silently skip modules that used to work.
        hasServerDirective =
          info?.fileLevel?.type === "server" ||
          hasDirectiveStatement(pre.ast, "use server");
      } catch {
        hasClientDirective =
          mayHaveClient && sourceHasTopLevelClientDirective(source);
        hasServerDirective = mayHaveServer;
      }
    }

    // An explicit `forceServerFunction: true` / `forceClientComponent: true` is
    // the caller overriding detection — honour it. Detection used to be loose
    // enough (a regex hit on a quoted `"use server"`) that a forced module
    // usually looked directive-bearing anyway and fell through by accident;
    // tightening detection made the override start getting skipped.
    const explicitlyForced =
      forceServerFunction === true || forceClientComponent === true;

    if (
      hasClientDirective === false &&
      hasServerDirective === false &&
      !explicitlyForced
    ) {
      // For files without directives, handle differently based on environment

      // A name like `Foo.client.tsx` reads as an intent to be a client module,
      // but only `"use client"` actually makes one — here and in every other
      // React toolchain. Say so instead of guessing: guessing would produce a
      // file that works under this loader and silently becomes a server module
      // anywhere else.
      if (looksLikeClientFilename(moduleId) && !warnedClientFilename.has(moduleId)) {
        warnedClientFilename.add(moduleId);
        logger.warn(
          `${moduleId} is named like a client module but has no "use client" directive, ` +
            `so it is being treated as a server module. Add "use client" to the top of the ` +
            `file if that is what you meant — the filename alone is not a portable signal.`
        );
      }

      if (isServerEnvironment && loader?.isClientComponentByName?.(moduleId, transformedModuleId)) {
        // Escape hatch only: the DEFAULT `isClientComponentByName` no longer
        // classifies by filename (see detectClientModule), so this branch is
        // reached solely when a project supplies its own predicate.
        if (verbose) {
          logger.info(
            `[createTransformer:server] Transforming client file without directive: ${moduleId}`
          );
        }
        forceClientComponent = true;
        // Don't return early - let it fall through to transformModule
      } else if (
        !isServerEnvironment &&
        !hasClientDirective &&
        !hasServerDirective &&
        !loader?.isClientComponentByName?.(moduleId, transformedModuleId) &&
        !isExternalModule(moduleId)
      ) {
        // In non-server environments, server components (modules without client/server directives and not client by name) should be hidden
        // This prevents server components from being loaded in client/ssr environments
        // But don't hide third-party modules from node_modules or modules with directives
        if (verbose) {
          logger.info(
            `[createTransformer:non-server] Hiding server component in non-server environment: ${moduleId}`
          );
        }
        // Return a module that exports null/undefined instead of empty string
        return { code: source, map: null };
      } else {
        // In client/ssr environments, we need to transform to remove directives
        // but we don't transform to registerClientReference
        if (hasClientDirective || hasServerDirective) {
          if (verbose) {
            logger.info(
              `[createTransformer:client] Transforming file with directives: ${moduleId}`
            );
          }
          // Transform to remove directives in client/ssr environment
          const parseResult = await analyzeModule(source, {
            ...options,
            logger,
            loader: loader,
          });

          if (parseResult.type === "success") {
            const result = await transformNonServerEnvironment(
              source,
              moduleId,
              transformedModuleId,
              parseResult,
              loader
            );
            if (verbose) {
              logger.info(
                `[createTransformer:client] Transformed result for ${moduleId}: ${result.code.substring(
                  0,
                  100
                )}`
              );
            }
            return result;
          }
        } else {
          // For files without directives in client/ssr environment, we still need to check
          // if this is a client component that should be transformed
          if (loader?.isClientComponentByName?.(moduleId, transformedModuleId)) {
            if (verbose) {
              logger.info(
                `[createTransformer:client] Transforming client component without directives: ${moduleId}`
              );
            }
            // Transform to ensure proper exports in client environment
            const parseResult = await analyzeModule(source, {
              ...options,
              logger,
              loader: loader,
            });

            if (parseResult.type === "success") {
              const result = await transformNonServerEnvironment(
                source,
                moduleId,
                transformedModuleId,
                parseResult,
                loader,
              );
              if (verbose) {
                logger.info(
                  `[createTransformer:client] Transformed result for ${moduleId}: ${result.code.substring(
                    0,
                    100
                  )}`
                );
              }
              return result;
            }
          }
        }
        // For files without directives and not identified as client components, keep original code
        return { code: source, map: null };
      }
    } else {
      // Set appropriate flags based on directives
      if (hasClientDirective) {
        forceClientComponent = true;
      }
      if (hasServerDirective) {
        forceServerFunction = true;
      }

      // Performance optimization: Check if file is already transformed to avoid unnecessary work
      // Only check this for files that actually have directives and are in the right environment
      if (isServerEnvironment && forceClientComponent) {
        const isAlreadyTransformed = source.includes(
          options?.loader?.registerClientReferenceName ??
            "registerClientReference"
        );

        if (isAlreadyTransformed) {
          logger.warn(
            `[createTransformer] File already transformed ${moduleId}. This call was not needed.`
          );
          return { code: source, map: null };
        }
      }
    }
    // Use analyzeModule to get the full parse result, passing the custom parseFn
    const parseResult = await analyzeModule(source, {
      ...options,
      logger,
      loader: loader,
    });
    if (
      parseResult.directiveInfo &&
      parseResult.directiveInfo.warnings.length > 0
    ) {
      const isProduction = getNodeEnv() === "production";

      // Handle directive errors (can be downgraded to warnings based on panicThreshold)
      for (const warning of parseResult.directiveInfo.warnings) {
        const shouldDowngradeToWarning =
          !isProduction && options.panicThreshold === "none";

        if (shouldDowngradeToWarning) {
          // Downgrade error to warning in development when panicThreshold is 'none'
          const [start, end] = warning.range;
          const lines = source.split("\n");
          const startLine = source.slice(0, start).split("\n").length;

          logger.warn(`Warning: ${warning.message}`);

          // Show document preview with line numbers
          const contextLines = 2; // Show 2 lines before and after
          const minLine = Math.max(1, startLine - contextLines);
          const maxLine = Math.min(lines.length, startLine + contextLines);

          for (let i = minLine; i <= maxLine; i++) {
            const lineNum = i.toString().padStart(3, " ");
            const isErrorLine = i === startLine;
            const prefix = isErrorLine ? ">" : " ";
            const line = lines[i - 1] || "";

            if (isErrorLine) {
              // Highlight the directive text itself using Vite's logger color methods
              const lineStart = source.lastIndexOf("\n", start - 1) + 1;
              const columnPos = Math.max(0, start - lineStart);
              const directiveLength = Math.max(1, end - start);

              // Split the line to highlight just the directive
              const beforeDirective = line.slice(0, columnPos);
              const directiveText = line.slice(
                columnPos,
                columnPos + directiveLength
              );
              const afterDirective = line.slice(columnPos + directiveLength);

              // Use picocolors for proper semantic coloring that adapts to themes
              logger.warn(
                `${prefix} ${lineNum} | ${beforeDirective}${red(
                  underline(directiveText)
                )}${afterDirective}`
              );
            } else if (line.trim() !== "") {
              logger.warn(`  ${lineNum} | ${line}`);
            }
          }
          logger.warn("");

          if (options.verbose) {
            logger.warn(`  range: [${start}, ${end}]`);
          }
        } else {
          // Treat as error (default behavior) - panic and stop compilation
          throw new Error(warning.message);
        }
      }
    }
    if (parseResult.type !== "success") {
      return { code: source, map: null };
    }

    // Transform the module
    // Only use explicit forceServerFunction/forceClientComponent in client environments
    // In client environments, auto-detected directives should go to transformNonServerEnvironment
    // (which throws errors for "use server" directives)
    const finalForceServerFunction = isServerEnvironment
      ? (forceServerFunction ?? hasServerDirective)
      : (explicitForceServerFunction ? forceServerFunction : undefined);
    const finalForceClientComponent = isServerEnvironment
      ? (forceClientComponent ?? hasClientDirective)
      : (explicitForceClientComponent ? forceClientComponent : undefined);

    return await transformModule(
      source,
      moduleId,
      transformedModuleId,
      parseResult,
      {
        forceServerFunction: finalForceServerFunction,
        forceClientComponent: finalForceClientComponent,
        isServerEnvironment,
        loader: options.loader,
        directiveWarnings: parseResult.directiveInfo.warnings,
        verbose: options.verbose || false,
        panicThreshold: options.panicThreshold || "none",
      }
    );
  };
};
