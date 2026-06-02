// Public surface of the transformer primitives.
//
// Pure functions: given a directive-bearing module source, produce a
// transformed source with the matching `registerClientReference` or
// `registerServerReference` calls injected. The output is what
// `react-server-dom-esm` expects to find at runtime when the server
// renderer encounters a client / server boundary.
//
// Bundler- and runtime-agnostic. A Vite plugin can call these from its
// `transform` hook; a Webpack loader can call them from its loader chain;
// a Node ESM `register()` setup can call them from its `load` hook.
// The transformer doesn't know or care which.

// Public surface (see docs/api-reference.md). The lower-level transform
// primitives (transformClientModule, transformServerModule,
// transformNonServerEnvironment, transformModuleIfNeeded, transformWithAcornLoose,
// removeDirectives, removeRanges, createSourceMap) are internal — used by
// createTransformer, not part of the supported API.
export { parse } from "./parse.js";
export { createTransformer } from "./createTransformer.js";
export { transformModule } from "./transformModule.js";

export { DEFAULT_LOADER_CONFIG } from "./defaults.js";

export type * from "./types.js";
