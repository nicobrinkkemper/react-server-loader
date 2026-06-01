# react-server-loader

Loader-side tooling for React Server Components in ESM environments.

This package gives a bundler, framework, or canonical Node setup the three
things it needs to render React Server Components in pure ESM:

- **A directive engine** that decides whether a module declares
  `"use client"` or `"use server"` at the top level — without false
  positives on identifiers or strings that merely contain those words.
- **Transformer primitives** that turn a directive-bearing module source
  into the `registerClientReference` / `registerServerReference` shape
  `react-server-dom-esm` expects at runtime.
- **A Node ESM loader factory** (`createReactLoader`) that wires the above
  into `node:module#register` so a plain `node --import register …` can
  serve RSC modules without a bundler at all.

The package vendors `react-server-dom-esm` directly (it isn't published
to npm by the React team), so consumers don't need to build the
transport from source.

## Install

```bash
npm install react-server-loader
```

You'll also need a matching `react` and `react-dom`:

```bash
npm install react react-dom
```

`react-server-loader`'s version tracks React's exactly — install the
`react-server-loader@<your-react-version>` train.

## Use it

### As a Node ESM loader (no bundler)

```ts
// register.mjs
import { register } from "node:module";
import { createReactLoader } from "react-server-loader/loader";

const { load, resolve } = createReactLoader({
  // Where your framework will serve client chunks from. The string this
  // returns is what ends up inside each emitted `registerClientReference`
  // call.
  moduleID: (filePath) => filePath.replace(process.cwd(), ""),
});

register(load, import.meta.url);
```

```bash
node --import ./register.mjs --conditions=react-server server.js
```

### As transformer primitives (inside a bundler plugin)

```ts
import { detectClientModule } from "react-server-loader/directives";
import { createTransformer } from "react-server-loader/transformer";

// In your bundler's transform hook:
if (detectClientModule({ source, moduleId: id })) {
  const transformer = createTransformer({
    options: {
      moduleID: yourBundlersHostedPathPolicy,
      verbose: false,
    },
  });
  return transformer(source, id, hostedID);
}
```

### Just the directive engine

```ts
import {
  detectClientModule,
  sourceHasTopLevelClientDirective,
  analyzeDirectives,
} from "react-server-loader/directives";
```

Useful for tooling that wants to identify RSC boundaries without
committing to a particular transform shape — type-checkers, lint rules,
build-graph analysers.

## Subpaths

| Subpath | Surface |
| --- | --- |
| `react-server-loader` | Top-level re-exports across the whole package. |
| `react-server-loader/directives` | Directive engine + the AST types it returns. No runtime dependency on the vendored transport. |
| `react-server-loader/transformer` | Source-to-source transformer primitives + the `DEFAULT_LOADER_CONFIG` defaults. No runtime dependency on the vendored transport. |
| `react-server-loader/loader` | `createReactLoader` factory returning Node ESM `load` / `resolve` hooks. Loads the vendored transport at runtime. |

## Overriding the contract

`DEFAULT_LOADER_CONFIG` matches the React-RSC contract published in
`react-server-dom-esm`. To wire the loader against an alternative
transport (Webpack, Parcel, a custom server), pass a `loader` override:

```ts
import { createReactLoader } from "react-server-loader/loader";

createReactLoader({
  moduleID: …,
  loader: {
    registerClientReferenceName: "myRegisterClientRef",
    importServerPath: "@my/transport/server",
    importClientPath: "@my/transport/server",
  },
});
```

## Versioning

`react-server-loader` versions track React's:

| React | `react-server-loader` |
| --- | --- |
| `19.0.0` (stable) | `react-server-loader@19.0.0` |
| `19.x.y` (stable) | `react-server-loader@19.x.y` |
| `0.0.0-experimental-<sha>-<date>` | `react-server-loader@0.0.0-experimental-<sha>-<date>` |

Install matching versions for `react`, `react-dom`, and
`react-server-loader` and the peer-dep checker will catch skew at
install time.

## Status

The package is in active development. Public API is still settling — the
top-level `createReactLoader` and the `react-server-loader/directives`
subpath are stable; the `react-server-loader/transformer` surface may
narrow as the public-facing pieces separate from internal helpers.

## License

MIT
