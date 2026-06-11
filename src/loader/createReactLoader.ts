import type { LoadHook, ResolveHook } from "node:module";
import { fileURLToPath } from "node:url";
import type { RawSourceMap } from "source-map";
import { detectClientModule } from "../directives/detectClientModule.js";
import { createTransformer } from "../transformer/createTransformer.js";
import { DEFAULT_LOADER_CONFIG } from "../transformer/defaults.js";
import {
  CONSOLE_LOGGER,
  NULL_LOGGER,
  type Logger,
} from "../directives/options.js";
import type { LoaderConfig } from "../transformer/types.js";

/**
 * Resolution policy: how the loader turns the URL Node hands it
 * (typically `file://…/foo.tsx`) into the hosted module ID that ends up
 * inside the emitted `registerClientReference` / `registerServerReference`
 * call. There is no universal answer — the policy depends on where the
 * containing framework will serve / bundle the client chunks. Pass a
 * function that maps a URL to the ID you want appearing in the client
 * reference.
 */
export type ModuleIDResolver = (
  filePath: string,
  source: string,
  isClientByDirective: boolean
) => string;

/**
 * Optional callback invoked after a module has been recognised as a
 * server / client RSC boundary and transformed. The bundler /
 * worker-orchestration layer above the loader can use it for whatever
 * cross-cutting concerns it has — emitting build manifest entries,
 * posting messages back to a parent thread, populating module graphs, etc.
 *
 * The loader itself does not look at the return value.
 */
export type OnTransformCallback = (info: {
  url: string;
  filePath: string;
  transformedId: string;
  source: string;
  isServer: boolean;
  isClient: boolean;
}) => void;

export interface CreateReactLoaderOptions {
  /**
   * RSC-contract overrides — the register-reference names, transport
   * import paths, directive matchers, etc. Defaults to the React-RSC
   * shape published in `react-server-dom-esm` (see `DEFAULT_LOADER_CONFIG`).
   */
  loader?: Partial<LoaderConfig>;

  /**
   * Maps a file URL to the hosted module ID emitted inside the
   * transformed module's `registerClientReference` / `registerServerReference`
   * calls. Required — the answer is consumer-specific.
   */
  moduleID: ModuleIDResolver;

  /**
   * Optional callback fired for every module the loader identified as
   * an RSC boundary, after the transform runs. Useful for upstream
   * orchestration (worker messaging, build manifests). The loader itself
   * does not inspect the return value.
   */
  onTransform?: OnTransformCallback;

  /** Logger backend. Defaults to a `console`-backed logger; pass
   * `NULL_LOGGER` to silence. */
  logger?: Logger;

  /** Print per-module trace lines via the logger when true. */
  verbose?: boolean;

  /**
   * Host policy: returns true when leading content above a file-level
   * directive is expected (e.g. bundler-injected preamble) and the
   * misplaced-directive warning should be suppressed. Forwarded to the
   * directive engine — see `TransformOptions.tolerateLeadingCode`.
   * Comments alone never need this: they are trivia and tolerated always.
   */
  tolerateLeadingCode?: (source: string) => boolean;
}

/**
 * Builds the `load` and `resolve` hooks for a React Server Components
 * Node ESM loader. The returned hooks plug into `node:module#register` or
 * `--experimental-loader` and convert `"use client"` / `"use server"`
 * modules into the contract `react-server-dom-esm` expects at runtime.
 *
 * The loader is transport-agnostic — the default `RSC_LOADER_CONFIG`
 * matches `react-server-dom-esm`, but a consumer can override
 * `options.loader` to integrate with a different RSC transport.
 *
 * @example
 * ```ts
 * // register.mjs
 * import { register } from "node:module";
 * import { createReactLoader } from "react-server-loader/loader";
 *
 * const { load, resolve } = createReactLoader({
 *   moduleID: (filePath) => filePath.replace(process.cwd(), ""),
 * });
 *
 * register(load, import.meta.url);
 * ```
 */
export function createReactLoader(options: CreateReactLoaderOptions): {
  load: LoadHook;
  resolve: ResolveHook;
} {
  const verbose = options.verbose ?? false;
  const logger = options.logger ?? (verbose ? CONSOLE_LOGGER : NULL_LOGGER);
  const loaderConfig: LoaderConfig = {
    ...DEFAULT_LOADER_CONFIG,
    ...(options.loader ?? {}),
  } as LoaderConfig;

  const transformer = createTransformer({
    options: {
      verbose,
      logger,
      loader: loaderConfig,
      tolerateLeadingCode: options.tolerateLeadingCode,
    },
  });

  const isServerFunction = loaderConfig.isServerFunctionCode;
  const isClientComponent = loaderConfig.isClientComponentCode;

  const load: LoadHook = async (url, context, nextLoad) => {
    const { format } = context;
    if (format !== "module" && format !== "module-typescript") {
      return nextLoad(url, context);
    }

    const result = await nextLoad(url, context);

    let source: string =
      typeof result.source === "string"
        ? result.source
        : result.source instanceof Uint8Array
        ? new TextDecoder().decode(result.source)
        : String(result.source);

    // Rewrite CJS named imports of `react`. Under the react-server
    // condition, `react` is published as CommonJS; esbuild / tsx
    // transforms produce ESM named imports that fail to resolve at
    // runtime. Translating each `import { X } from "react"` to a default
    // import + destructure restores compatibility. Applies to user code
    // and to node_modules — third-party packages (e.g. component
    // libraries' compiled ESM) hit the same wall.
    const namedImportRe = /import\s*\{([^}]+)\}\s*from\s*["']react["']\s*;?/g;
    if (namedImportRe.test(source)) {
      namedImportRe.lastIndex = 0;
      let counter = 0;
      source = source.replace(
        namedImportRe,
        (_match: string, imports: string) => {
          const alias = `__react_cjs_${counter++}`;
          return `import ${alias} from "react"; const {${imports}} = ${alias};`;
        }
      );
      if (verbose) {
        logger.info(`[react-loader] rewrote CJS React imports: ${url}`);
      }
    }

    // File-level `"use server"` detection. The unified `detectClientModule`
    // helper covers the client side; the server side uses an inline
    // prologue-walking scanner that tolerates `"use strict"` and other
    // string-literal directives ahead of `"use server"`.
    const hasFileLevelServerDirective = (): boolean => {
      const target = "use server";
      let i = 0;
      for (let k = 0; k < 10; k++) {
        while (i < source.length && /\s/.test(source[i]!)) i++;
        const quote = source[i];
        if (quote !== '"' && quote !== "'") return false;
        const close = source.indexOf(quote, i + 1);
        if (close < 0) return false;
        if (source.slice(i + 1, close) === target) return true;
        i = close + 1;
        while (i < source.length && /[\s;]/.test(source[i]!)) i++;
        if (i >= source.length) return false;
      }
      return false;
    };

    const isClientByDirective = detectClientModule({ source, moduleId: url });

    const isServer =
      hasFileLevelServerDirective() ||
      (typeof isServerFunction === "function"
        ? isServerFunction(source, url)
        : false);

    const isClient =
      isClientByDirective ||
      (typeof isClientComponent === "function"
        ? isClientComponent(source, url)
        : false);

    if (!isServer && !isClient) {
      // Not an RSC boundary. Return the (possibly CJS-import-rewritten)
      // source untouched — plain modules running under the react-server
      // condition still need the rewrite to compile React's CommonJS
      // exports against ESM named-import syntax.
      return { ...result, source };
    }

    if (verbose) {
      logger.info(
        `[react-loader] ${isServer ? "server" : "client"} module: ${url}`
      );
    }

    const filePath = url.startsWith("file://") ? fileURLToPath(url) : url;
    const transformedId = options.moduleID(
      filePath,
      source,
      isClientByDirective
    );

    const { code: transformed, map } = (await transformer(
      source,
      filePath,
      transformedId
    )) as { code: string; map: RawSourceMap | null };

    options.onTransform?.({
      url,
      filePath,
      transformedId,
      source: transformed,
      isServer,
      isClient,
    });

    return {
      ...result,
      source: transformed,
      ...(map ? { map: map as unknown } : {}),
    };
  };

  // The resolve hook is a no-op today; future work may use it to thread
  // import-map overrides or hosted-path rewriting in the resolver layer.
  const resolve: ResolveHook = async (specifier, context, nextResolve) =>
    nextResolve(specifier, context);

  return { load, resolve };
}
