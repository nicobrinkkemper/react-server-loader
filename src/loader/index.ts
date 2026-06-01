// Public surface of the Node ESM loader scaffolding.
//
// Populate from vite-plugin-react-server in a follow-up:
//   - load / resolve hooks (parametrised — consumer supplies the transport)
//   - createDefaultLoader (plugin/loader/createDefaultLoader.ts)
//   - registerLoaders     (plugin/worker/registerLoaders.ts)
//
// The bare loader must be wireable via `node --import <pkg>/register` for
// canonical use; the worker / Vite path remains an opt-in wrap-around.
export {};
