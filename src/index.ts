// Top-level re-exports. Both `./directives` and `./transformer` declare
// `ParseFn` and `TransformResult` types with slightly different shapes;
// `./transformer` is the public source-of-truth at the top level (it's the
// shape callers receive from `transformModuleIfNeeded`). Subpath imports
// (`react-server-loader/directives`) still see the directives-specific
// shape unchanged.
export * from "./directives/index.js";
export {
  parse,
  createTransformer,
  transformModuleIfNeeded,
  transformWithAcornLoose,
  transformModule,
  transformClientModule,
  transformServerModule,
  transformNonServerEnvironment,
  removeDirectives,
  removeRanges,
  createSourceMap,
  DEFAULT_LOADER_CONFIG,
  DEFAULT_CONFIG,
  DIRECTIVE_CONFIGS,
} from "./transformer/index.js";
export type { LoaderConfig, TransformOptions } from "./transformer/types.js";
export * from "./loader/index.js";
