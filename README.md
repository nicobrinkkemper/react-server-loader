# react-server-loader

Loader-side tooling for React Server Components in ESM environments. Directive detection, module transformation primitives, and Node ESM loader scaffolding — usable from any framework that needs to handle `"use client"` / `"use server"` modules without committing to a specific bundler or transport.

## What's in here

- **Directive engine** — structural detection of top-of-file `"use client"` / `"use server"` directives. Tolerates leading whitespace, line/block comments, and a `"use strict"` prologue; rejects substring matches against `"client"` in identifiers, comments, or import paths.
- **Transformer primitives** — pure functions that turn a directive-bearing module source into a transformed source with `registerClientReference` / `registerServerReference` calls injected. Environment-agnostic (no Vite, no Rollup, no Node-loader dependencies).
- **Node ESM loader scaffolding** — `load` / `resolve` hooks compatible with `node:module#register()` and `--experimental-loader`, parametrized so a consumer can wire in their own transport package.

This package is intentionally **transport-agnostic**. It does not bundle `react-server-dom-esm` or any specific RSC transport — that's a separate concern, and decoupling them lets non-RSC ESM projects (or alternative transports) use the directive + transformer primitives without pulling in React's server-DOM bindings.

## Status

Pre-publish skeleton. Public API not yet stable.

## License

MIT
