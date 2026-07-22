// The vendored transport entries are plain JS (React's built output) with no
// type declarations; these ambient modules keep the runtime helpers compiling
// without inventing types for React's surface.
declare module "react-server-loader/webpack/client" {
  const surface: Record<string, unknown> & { default?: Record<string, unknown> };
  export = surface;
}
declare module "react-server-loader/webpack/client.browser" {
  const mod: Record<string, unknown> & { default?: Record<string, unknown> };
  export = mod;
}
declare module "react-server-loader/webpack/client.edge" {
  const mod: Record<string, unknown> & { default?: Record<string, unknown> };
  export = mod;
}
declare module "react-server-loader/webpack/client.node" {
  const mod: Record<string, unknown> & { default?: Record<string, unknown> };
  export = mod;
}
