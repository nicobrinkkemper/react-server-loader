# Integrating react-server-loader into a bundler or framework

`react-server-loader` (rsl) ships no Vite — or any bundler — assumptions. It
gives you the directive engine, the transformer, and the Node ESM loader; you
supply the bundler-specific policy. This guide walks the two wiring points a
bundler/framework needs, using Vite as the worked example. The reference
integration is
[`vite-plugin-react-server`](https://github.com/nicobrinkkemper/vite-plugin-react-server)
(vprs); its `plugin/loader/react-loader.ts` is the production version of the
loader wiring below.

There are two places React Server Components must be transformed, and rsl has a
piece for each:

1. **The bundler's `transform` hook** — for the client/browser build, where
   your bundler hands you each module's source. Use the directive engine to
   detect RSC boundaries and the transformer to rewrite them.
2. **The server render** — under `node --conditions react-server`, where
   modules are loaded (not bundled). Use the Node ESM loader to transform
   server modules on import.

You can use either independently, but a full RSC integration wires both.

## Prerequisites

Install rsl alongside the React you build against (the versions line up — see
[the *Versioning* guide](./versioning.md)):

```bash
npm install react-server-loader react react-dom
```

## 1. The transform hook

For the client and SSR builds, your bundler calls a `transform(code, id)` hook
per module. Two rsl calls do the work:

- `detectClientModule({ source, moduleId })` from
  `react-server-loader/directives` decides whether the module declares a
  top-level `"use client"` directive (or matches the `.client.*` filename
  convention). It rejects substring matches in identifiers, comments, and
  import paths — no false positives.
- `createTransformer({ options })` from `react-server-loader/transformer`
  returns a transform function. Call it `transform(source, moduleId)` and it
  returns `{ code, map }`.

```ts
import { detectClientModule } from "react-server-loader/directives";
import { createTransformer } from "react-server-loader/transformer";

// Vite prepends imports — __vitePreload, the HMR client, import.meta.hot —
// ahead of a "use client" directive. That leading code is legitimate, so
// tell the directive engine to tolerate it instead of warning that the
// directive isn't at the top of the file.
const tolerateLeadingCode = (src: string) =>
  src.includes("__vitePreload") ||
  src.includes("/@vite/client") ||
  src.includes("import.meta.hot");

const transform = createTransformer({
  options: { moduleBase: "/", tolerateLeadingCode },
});

// inside your plugin's transform(code, id):
export async function transformHook(code: string, id: string) {
  if (!detectClientModule({ source: code, moduleId: id })) {
    return null; // not an RSC boundary — let the bundler keep the original
  }
  return transform(code, id); // -> { code, map }
}
```

### Why `tolerateLeadingCode` matters for Vite

React's contract puts the directive at the very top of the module, above any
imports. Vite injects its own imports ahead of your code, which would otherwise
trip the engine's "directive must be at the top" warning. `tolerateLeadingCode`
is a host predicate `(source: string) => boolean`: return `true` when you know
the leading code was injected by your bundler, and the placement warning is
suppressed. rsl ships no bundler-specific assumptions here — the predicate is
yours to define. If you omit it, the engine is strict (no tolerance), which is
the right default for a non-bundled environment like the Node loader below.

### Transformer options

`createTransformer({ options })` accepts these option fields (all optional):

| field | type | purpose |
| --- | --- | --- |
| `loader` | `Partial<LoaderConfig>` | Override the transport contract (see [Overriding the transport contract](#3-overriding-the-transport-contract)). |
| `logger` | `Logger` | Logging backend; defaults to a silent logger. |
| `verbose` | `boolean` | Emit a per-module trace through the logger. |
| `moduleBase` | `string` | Base used when computing emitted module IDs. |
| `panicThreshold` | `"none" \| …` | Whether directive-placement problems throw or downgrade to warnings. |
| `tolerateLeadingCode` | `(source: string) => boolean` | Suppress the placement warning for bundler-injected leading code. |

The returned function is `(source, moduleId, transformedModuleId?) => Promise<{ code, map }>`.
If you don't pass `transformedModuleId`, it falls back to `moduleId` (or your
`loader.moduleID` policy, if you set one).

### Just detecting, without transforming

If you only need RSC-boundary detection — for a lint rule, a type-checker, or a
build-graph analysis — reach for the directive engine alone:

```ts
import {
  detectClientModule,
  sourceHasTopLevelClientDirective,
  analyzeModule,
} from "react-server-loader/directives";
```

`sourceHasTopLevelClientDirective(source)` is the pure source check (no
filename heuristic); `analyzeModule(source, options?)` returns a fuller parse
result and accepts the same `tolerateLeadingCode` predicate.

## 2. The server loader

The server render runs under `node --conditions react-server`, where React and
the transport resolve to their server builds. Modules are *loaded*, not
bundled, so the transform happens in a Node ESM loader. `createReactLoader`
builds that loader's `load` / `resolve` hooks.

```ts
import { createReactLoader } from "react-server-loader/loader";

const { load, resolve } = createReactLoader({
  // Required. Maps the on-disk file to the hosted module ID baked into each
  // emitted registerClientReference / registerServerReference — i.e. where
  // the client will fetch that chunk from. The answer is consumer-specific.
  moduleID: (filePath) => yourHostedPathPolicy(filePath),

  // Optional. Route rsl's logs into your framework's logger.
  logger,

  // Optional. Fired for each module the loader transformed — feed a worker,
  // a build manifest, or an HMR channel. The loader stays orchestration-free.
  onTransform: ({ filePath, transformedId, source }) => {
    /* e.g. postMessage to a parent thread, record a manifest entry */
  },
});
```

Register the hooks with `node:module`:

```ts
// register.mjs
import { register } from "node:module";
import { createReactLoader } from "react-server-loader/loader";

const { load } = createReactLoader({
  moduleID: (filePath) => filePath.replace(process.cwd(), ""),
});

register(load, import.meta.url);
```

```bash
node --import ./register.mjs --conditions=react-server server.js
```

### Loader options

`createReactLoader(options)` — only `moduleID` is required:

| option | type | default | purpose |
| --- | --- | --- | --- |
| `moduleID` | `(filePath: string, source: string, isClientByDirective: boolean) => string` | — | Maps an on-disk module to the hosted ID emitted in the client/server reference. Most policies only use `filePath`; the extra args are available when you need them. |
| `loader` | `Partial<LoaderConfig>` | the `react-server-dom-esm` contract | Override the transport contract (see below). |
| `logger` | `Logger` | console-backed when `verbose`, otherwise silent | Logging backend. |
| `verbose` | `boolean` | `false` | Emit a per-module trace. |
| `onTransform` | `(info) => void` | — | Fired for each transformed module. `info` is `{ url, filePath, transformedId, source, isServer, isClient }`. The loader ignores the return value. |

### How vprs wires it

In vprs, this lives in a worker thread. At init time the plugin materializes
its default `moduleID` policy (if the user didn't supply one), then passes it,
the Vite logger, and an `onTransform` that posts each transformed module back
to the parent thread over a `MessagePort`:

```ts
const { load, resolve } = createReactLoader({
  loader: userOptions.loader,
  verbose,
  logger,
  moduleID: (filePath) => /* normalize -> hosted path */ filePath,
  onTransform: ({ filePath, transformedId, source }) => {
    loaderPort.postMessage({
      type: "SERVER_MODULE",
      id: transformedId,
      url: filePath,
      source,
    });
  },
});
```

The hooks `createReactLoader` returns are then published on the worker's
bootstrap path. See vprs's `plugin/loader/react-loader.ts` for the full
production wiring.

## 3. Overriding the transport contract

By default rsl emits the `registerClientReference` /
`registerServerReference` shape that `react-server-dom-esm` expects at runtime
(`DEFAULT_LOADER_CONFIG`). To target a different RSC transport — Webpack,
Parcel, or a custom server — pass a `loader` override. The same `loader`
option exists on both `createReactLoader` and `createTransformer`, so a
non-`react-server-dom-esm` transport is wired the same way at either point:

```ts
import { createReactLoader } from "react-server-loader/loader";

createReactLoader({
  moduleID: yourHostedPathPolicy,
  loader: {
    registerClientReferenceName: "myRegisterClientRef",
    importServerPath: "@my/transport/server",
    importClientPath: "@my/transport/server",
  },
});
```

The override is a `Partial<LoaderConfig>` merged over the defaults, so you only
specify the fields that differ. The common ones are the register-reference
function names (`registerClientReferenceName`,
`registerServerReferenceName`) and the transport import paths
(`importServerPath`, `importClientPath`).

## Logging

Both the loader and the directive/transformer engines log through a minimal
`Logger` (`info` / `warn` / `error`), re-exported from
`react-server-loader/loader` with two built-in backends:

```ts
import {
  createReactLoader,
  CONSOLE_LOGGER,
  NULL_LOGGER,
  type Logger,
} from "react-server-loader/loader";

createReactLoader({ moduleID, logger: NULL_LOGGER }); // silence everything
createReactLoader({ moduleID, verbose: true });       // console backend, full trace

// Route into your framework's logger:
const logger: Logger = { info: log.debug, warn: log.warn, error: log.error };
createReactLoader({ moduleID, logger });
```

Without `verbose`, only warnings and errors surface; `NULL_LOGGER` silences
those too. `createTransformer` and `analyzeModule` accept the same
`logger` / `verbose`.

## See also

- [README](../README.md) — overview, install, and the subpath surface.
- [API reference](./api-reference.md) — full per-subpath signatures.
- [Versioning](./versioning.md) — the two trains and the peer-dependency
  contract.
- [`vite-plugin-react-server`](https://github.com/nicobrinkkemper/vite-plugin-react-server)
  — the reference Vite integration.
