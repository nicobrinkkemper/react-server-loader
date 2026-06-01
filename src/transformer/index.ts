// Public surface of the transformer primitives.
//
// Today this is just `parse` (an acorn-based parser that returns a Rollup-
// shaped `{ ast, code, map? }`). Source-transformation primitives — the
// "given a `use client` module source, produce a transformed source with
// `registerClientReference` calls injected" engine — land in a follow-up
// once the directive engine is locked in.

export { parse } from "./parse.js";
