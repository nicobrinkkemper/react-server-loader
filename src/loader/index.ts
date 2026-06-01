// Public surface of the Node ESM loader layer.
//
// `createReactLoader` returns `load` and `resolve` hooks compatible with
// `node:module#register` and `--experimental-loader`. The loader is
// transport-agnostic: defaults match the React-RSC contract published in
// `react-server-dom-esm`, but the `options.loader` shape lets you wire
// the loader against a different transport. The hosted-path policy
// (the `moduleID` callback) is consumer-provided — the loader has no
// opinion on where a framework will serve its client chunks from.

export {
  createReactLoader,
  type CreateReactLoaderOptions,
  type ModuleIDResolver,
  type OnTransformCallback,
} from "./createReactLoader.js";
