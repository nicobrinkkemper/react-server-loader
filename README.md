# react-server-loader

The React-version-locked half of an ESM React Server Components setup:
the vendored RSC transport (server **and** browser client), a directive
engine, transformer primitives, and a Node ESM loader.

> **Despite the name, this is not only a Node loader.** The vendored
> transport includes `client.browser` — the flight client your BROWSER
> bundle ships to decode RSC payloads and hydrate. Everything in this
> package shares one property: it must match your React version exactly,
> which is why versions mirror React's (`19.2.x` stable,
> `0.0.0-experimental-*`).

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
- **A vendored `react-server-dom-webpack` transport** (under
  `react-server-loader/webpack/*`) — React's module-map transport, built from
  the *same* React checkout at the *same* ref as the esm one. Where the esm
  client resolves references by `import(specifier)`, this one resolves them
  through a client manifest (`id → {id, chunks, name}`) — the closed-registry
  model a self-contained production bundle needs. One rsl version pins both
  transports to one React build.
- **A directive engine** that decides whether a module declares
  `"use client"` or `"use server"` at the top level — without false
  positives on identifiers or strings that merely contain those words.
- **Transformer primitives** that rewrite a directive-bearing module into
  the `registerClientReference` / `registerServerReference` shape the
  transport expects at runtime.
- **A Node ESM loader factory** (`createReactLoader`) that wires the above
  into `node:module#register`, so a plain `node --import … --conditions
  react-server` serves RSC modules with no bundler at all.

## Why not React's reference loader?

`react-server-dom-esm` ships a reference Node loader
(`react-server-dom-esm/node-loader`). This package implements its own
instead, because the reference loader:

- parses source as plain JS — no TypeScript/TSX at load time, which a dev
  server importing project source needs;
- hardcodes file URLs as client-reference module IDs — there is no seam to
  inject a hosted-ID policy that matches a build's chunk naming (hash,
  base path), and that seam is where bundler integration actually lives;
- does no CJS interop for `react` under the react-server condition, so
  esbuild/tsx-emitted named imports (`import { useState } from "react"`)
  fail at link time;
- is hardwired to the esm transport, where `createReactLoader`
  parametrizes the transport via `LoaderConfig`;
- is single-process — no hook for worker/MessagePort orchestration;
- keeps its directive detection separate from any build-time transformer,
  reintroducing the worker-vs-bundler classification drift this package's
  shared `detectClientModule` exists to prevent;
- and lives in the same unpublished package as the transport — consuming
  it would still mean vendoring.

## Install

`react-server-loader` ships **two trains**, one per React release channel.
The transport is hard-bound to one React build's internals, so install a
**matching** `react` / `react-dom` — and trust the **peer dependency** (not
the version number) to tell you which: the peer names the exact React the
transport was vendored from, while the version is rsl's own (`@types`-style —
major.minor tracks React, the patch is rsl's revision). Pick the train for the
React you build against; the peer-dependency check flags any skew.

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

## Securing references: the manifest gate

A server-action id and a client-reference id both arrive **from the client**.
The transport's own resolution checks only that the id's path sits under a base
URL and then imports it — an open allowlist: any module under the root can be
imported and any of its exports invoked, whether or not it was ever marked
`"use server"`. The bundler transports (webpack/parcel) and the official Vite
plugin avoid this by resolving against a **closed, build-time manifest** of
references: a dictionary lookup that throws on an unknown id. The ESM transport
ships no such manifest because it has no bundler to build one.

`createReferenceGate` is that manifest, authored here so it works under any
transport. The contract is intentionally tiny — the only input is
`(hostedId → real importer)` pairs:

```ts
import { createReferenceGate, createReactLoader } from "react-server-loader";

// One gate per server. Seal it in production; leave it open in dev.
const gate = createReferenceGate({
  mode: process.env.NODE_ENV === "production" ? "sealed" : "open",
});

// The loader registers every boundary it transforms — keyed by the hosted id
// your moduleID emits, with an importer bound to the module's REAL url.
const { load } = createReactLoader({
  moduleID: (filePath) => filePath.replace(process.cwd(), ""),
  gate,
});

// After a build pass has driven every boundary through the loader:
gate.seal();

// Resolve incoming ids through the gate instead of importing their path:
const action = await gate.resolveServerReference(idFromClient); // throws if unknown
```

Why this closes the hole:

- **The incoming id is only ever a dictionary key.** Resolution imports the
  build-bound module, never a path derived from the id, so a forged id — or one
  containing `../` — can't reach anything. An id that was never registered
  simply isn't a key, which makes traversal *structurally* impossible rather
  than something to filter.
- **A registered module can't be used to reach an unmarked export.** After
  import, the named export is verified to carry React's registered-reference tag
  before it is returned.

**Dev vs production.** `sealed` is the trust boundary: an unregistered id
throws. `open` is a development convenience — with a `devResolve` it falls back
to importing an as-yet-unregistered id on demand, so the no-bundler workflow
works before a build pass has enumerated everything. **Open mode is not a trust
boundary**; only wire it where the server isn't exposed to untrusted clients
(the same dev/prod split the official Vite plugin and React's own fixtures use).

**Feeding it from a bundler.** Because the only input is `(hostedId → importer)`
pairs, any integration can fill the gate: a Vite/Rollup/Rolldown plugin
enumerates boundaries from the module graph at build; webpack/parcel already
carry their own manifest and can map it into `register()` (or rely on their
transport's built-in gate). The ESM transport is the case where the gate is
load-bearing. See
[Integrating into a bundler or framework](docs/integrating.md).

## Subpaths

| Subpath | Surface |
| --- | --- |
| `react-server-loader/loader` | `createReactLoader` → Node ESM `load` / `resolve` hooks; the `Logger` contract + `CONSOLE_LOGGER` / `NULL_LOGGER` backends. |
| `react-server-loader/directives` | Directive engine: `detectClientModule`, `sourceHasTopLevelClientDirective`, `analyzeModule`. Pure analysis, no transport dependency. |
| `react-server-loader/transformer` | Source-to-source transform: `createTransformer`, `parse`, `transformModule`. |
| `react-server-loader/references` | The manifest gate: `createReferenceGate` → a closed `(hostedId → importer)` allowlist with `register` / `seal` / `resolveServerReference` / `resolveClientReference`. Transport-agnostic; closes the open reference resolution. |
| `react-server-loader/server` (`/server.node`) | Vendored transport, server: `renderToPipeableStream`, `registerClientReference`, `registerServerReference`, `decodeReply`, `createTemporaryReferenceSet` (needs `--conditions react-server`). |
| `react-server-loader/client` (`/client.node`, `/client.browser`) | Vendored transport, client: `createFromNodeStream`, `createServerReference`. |
| `react-server-loader/static` (`/static.node`) | Vendored transport, static entry. In this React build it re-exports the server surface — `react-server-dom-esm` ships no separate static module. |
| `react-server-loader/webpack/server` (`/server.node`, `/server.edge`, `/server.browser`) | Vendored `react-server-dom-webpack`, server: `renderToPipeableStream` / `renderToReadableStream` against a webpack-shaped client manifest, plus the decode/register surface (needs `--conditions react-server`). |
| `react-server-loader/webpack/client` (`/client.browser`, `/client.node`, `/client.edge`) | Vendored `react-server-dom-webpack`, client: manifest-driven decode — `client.edge` takes a `serverConsumerManifest` for in-process HTML decode; `client.browser` consumes `__webpack_require__`-style module/chunk shims. |
| `react-server-loader/webpack/static` (`/static.node`, `/static.edge`, `/static.browser`) | Vendored `react-server-dom-webpack`, static prerender entries. |
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
