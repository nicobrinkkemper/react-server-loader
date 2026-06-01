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

export { parse } from "./parse.js";
export { createTransformer } from "./createTransformer.js";
export { transformModuleIfNeeded } from "./transformModuleIfNeeded.js";
export { transformWithAcornLoose } from "./transformWithAcornLoose.js";
export { transformModule } from "./transformModule.js";
export { transformClientModule } from "./transformClientModule.js";
export { transformServerModule } from "./transformServerModule.js";
export { transformNonServerEnvironment } from "./transformNonServerEnvironment.js";
export { removeDirectives } from "./removeDirectives.js";
export { removeRanges } from "./removeRanges.js";
export { createSourceMap } from "./sourceMap.js";

export {
  DEFAULT_LOADER_CONFIG,
  DEFAULT_CONFIG,
  DIRECTIVE_CONFIGS,
} from "./defaults.js";

export type * from "./types.js";
