// Top-level re-exports: the full consumer-facing public surface, drawn from
// the (now-curated) subpath indexes. The headline entry points are
// createReactLoader, detectClientModule, and createTransformer; the rest of
// the public API (analyzeModule, parse, transformModule, the Logger backends,
// the public types) comes along for convenience. Internal helpers are not
// re-exported here because the subpaths no longer expose them.
export * from "./directives/index.js";
export {
  parse,
  createTransformer,
  transformModule,
  DEFAULT_LOADER_CONFIG,
} from "./transformer/index.js";
export type { LoaderConfig, TransformOptions } from "./transformer/types.js";
export * from "./loader/index.js";
