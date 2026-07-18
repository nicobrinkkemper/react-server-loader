// Public surface of the webpack-transport runtime adapters.
//
// The vendored react-server-dom-webpack transport reads bundler-injected
// globals for module loading. These helpers provide those globals from a
// closed registry (a baked bundle's module set) or from the sealed reference
// gate — the non-webpack host's side of the transport contract, owned here so
// every consumer doesn't re-derive the eval-order, dev/prod-naming, and
// async-preload subtleties.
export {
  installWebpackGlobals,
  type WebpackGlobalsOptions,
  type WebpackGlobalsHandle,
  type ModuleExports,
} from "./installWebpackGlobals.js";
export { gateModuleLoader } from "./gateModuleLoader.js";
export {
  createWebpackClient,
  type CreateWebpackClientOptions,
  type WebpackClientTarget,
} from "./createWebpackClient.js";
