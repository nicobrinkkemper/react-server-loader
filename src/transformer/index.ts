// Public surface of the transformer primitives.
//
// Pure functions: given a directive-bearing module source, produce a
// transformed source with `registerClientReference` / `registerServerReference`
// calls injected. Environment-agnostic — no Vite, no Rollup, no Node-loader
// dependencies. The Vite plugin (`vite-plugin-react-server`) wraps these to
// wire them into Vite's transform hook; canonical Node ESM loader setups can
// call them directly.

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
