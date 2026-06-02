# react-server-loader

Loader-side tooling for React Server Components in ESM environments.

> **Scope:** use React, but with a native-ESM workflow in mind. Anything
> that helps you run React (and RSC) in pure ESM belongs here; shipping a
> *copy* of React does not — `react`/`react-dom` always come from the
> consumer.

React doesn't publish an ESM RSC transport to npm. This package fills that
gap with the four things a bundler, framework, or canonical Node setup needs
to render React Server Components in pure ESM:

- **A vendored `react-server-dom-esm` transport** — the RSC wire format
  React builds but doesn't ship to npm, vendored so you don't build it from
  source.
- **A directive engine** that decides whether a module declares
  `"use client"` or `"use server"` at the top level — without false
  positives on identifiers or strings that merely contain those words.
- **Transformer primitives** that rewrite a directive-bearing module into
  the `registerClientReference` / `registerServerReference` shape the
  transport expects at runtime.
- **A Node ESM loader factory** (`createReactLoader`) that wires the above
  into `node:module#register`, so a plain `node --import … --conditions
  react-server` serves RSC modules with no bundler at all.

## Install

`react-server-loader` ships **two trains**, one per React release channel.
Its version equals the `react-server-dom-esm` (React) version it vendors, and
the transport is hard-bound to that React's internals — so install a
**matching** `react` / `react-dom`. Pick the train for the React you build
against; the peer-dependency check flags any skew.

**Stable React 19** (the `latest` tag):

```bash
npm install react-server-loader react react-dom
```

**Experimental React** (the `experimental` tag — newest RSC features):

```bash
npm install react-server-loader@experimental react@experimental react-dom@experimental
```

Either way you need a React **19+** build with React Server Components
support. The experimental train pins `react` / `react-dom` to an exact build
string and needs more care — see [Versioning](docs/versioning.md) for the
full rationale and the exact-pin recipe.

## Quickstart: render RSC with no bundler

Two steps — register the loader so directive modules transform on import,
then render and decode with the transport. The server half runs under
`node --conditions react-server` so `react` and the transport resolve to
their server builds.

```ts
// register.mjs — install the loader
import { register } from "node:module";
import { createReactLoader } from "react-server-loader/loader";

const { load } = createReactLoader({
  // Maps an on-disk module to the id baked into each emitted
  // registerClientReference — i.e. where the client will fetch it from.
  moduleID: (filePath) => filePath.replace(process.cwd(), ""),
});
register(load, import.meta.url);
```

```tsx
// server.tsx — render a server component tree to an RSC stream
import { renderToPipeableStream } from "react-server-loader/server";
import App from "./App.js";

const { pipe } = renderToPipeableStream(<App />, "/");
pipe(destination); // any Node Writable — receives the RSC payload
```

```ts
// client.tsx — decode the stream back into a React tree
import { createFromNodeStream } from "react-server-loader/client";

const root = await createFromNodeStream(rscStream, "/", "/");
```

```bash
node --import ./register.mjs --conditions=react-server server.js
```

The full walkthrough — server component, directive modules, and why each
path argument lines up — is in
[Getting started](docs/getting-started.md).

## Subpaths

| Subpath | Surface |
| --- | --- |
| `react-server-loader/loader` | `createReactLoader` → Node ESM `load` / `resolve` hooks; the `Logger` contract + `CONSOLE_LOGGER` / `NULL_LOGGER` backends. |
| `react-server-loader/directives` | Directive engine: `detectClientModule`, `sourceHasTopLevelClientDirective`, `analyzeModule`. Pure analysis, no transport dependency. |
| `react-server-loader/transformer` | Source-to-source transform: `createTransformer`, `parse`, `transformModule`. |
| `react-server-loader/server` (`/server.node`) | Vendored transport, server: `renderToPipeableStream`, `registerClientReference`, `registerServerReference`, `decodeReply`, `createTemporaryReferenceSet` (needs `--conditions react-server`). |
| `react-server-loader/client` (`/client.node`, `/client.browser`) | Vendored transport, client: `createFromNodeStream`, `createServerReference`. |
| `react-server-loader/static` (`/static.node`) | Vendored transport, static entry. In this React build it re-exports the server surface — `react-server-dom-esm` ships no separate static module. |
| `react-server-loader` | Re-exports the full public surface for convenience (headline: `createReactLoader`, `detectClientModule`, `createTransformer`). |

Import only from these subpaths and the symbols named here — they are the
supported, consumer-facing surface. AST type-guards and low-level transform
helpers are internal, not exported, and may change without a major bump. Full
per-subpath signatures are in the [API reference](docs/api-reference.md).

## Documentation

- **[Getting started](docs/getting-started.md)** — install the two trains and
  run the end-to-end no-bundler RSC example.
- **[Integrating into a bundler or framework](docs/integrating.md)** — the
  `transform` hook and the server loader, with Vite as the worked example.
- **[API reference](docs/api-reference.md)** — per-subpath signatures for the
  consumer-facing surface.
- **[Versioning](docs/versioning.md)** — the two trains, the peer-dependency
  contract, and why `react` / `react-dom` must match.
- **[Troubleshooting](docs/troubleshooting.md)** — symptom → cause → fix for
  version skew, the `react-server` condition, and peer-dep errors.

Implementing or releasing rsl? See [docs/internals/](docs/internals/) for the
architecture, the directive engine, the transformer primitives, and the
vendoring/publishing pipeline.

## License

MIT
