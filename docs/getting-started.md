# Getting started

`react-server-loader` (rsl) lets you render React Server Components in a
**native-ESM workflow** — no bundler required. It packages the three things
React itself doesn't publish to npm for an ESM/RSC setup: the
`react-server-dom-esm` transport, a directive engine, and a Node ESM loader
that transforms `"use client"` / `"use server"` modules on import.

This guide installs the package and walks an end-to-end "render RSC with no
bundler" example you can run with plain `node`.

## Install

`react-server-loader` ships **two trains**, one per React release channel.
The transport is hard-bound to one React build's internals, so you must
install a **matching** `react` / `react-dom` — and the **peer dependency**
(not the version number) is what names the right React. Pick the train for
the React you build against; a plain install lines everything up and the
peer-dependency check flags any skew.

**Stable React 19** (the `latest` tag):

```bash
npm install react-server-loader react react-dom
```

The stable version is rsl's own — major.minor tracks React's minor, the patch
is rsl's revision (`@types`-style), e.g. `react-server-loader@19.2.8` vendors
React `19.2.7`. Which React it needs is in the peer (`^19.2.7`), so a plain
`npm install react-server-loader react react-dom` resolves `react` to a
matching build.

**Experimental React** (the `experimental` tag — newest RSC features):

```bash
npm install react-server-loader@experimental react@experimental react-dom@experimental
```

The experimental train is stricter: it versions as
`0.0.0-experimental-<sha>-<date>` and pins `react` / `react-dom` to that
**exact** string. The `react@experimental` dist-tag moves daily, so it only
lines up when both were built from the same React commit. When in doubt, pin
the exact version:

```bash
npm view react-server-loader@experimental peerDependencies
npm install react@<that-exact-version> react-dom@<that-exact-version>
```

Either way you need a React **19+** build with React Server Components
support. See [Versioning](./versioning.md) for the full rationale.

## Render RSC with no bundler

The flow is three pieces:

1. **Register the loader** so `"use client"` / `"use server"` modules
   transform on import.
2. **Render** a server component tree to an RSC stream with the transport's
   `renderToPipeableStream`.
3. **Decode** that stream back into a React tree with the transport's
   `createFromNodeStream`.

The server half runs under `node --conditions react-server` so `react` and
the transport resolve to their server builds.

### 1. A server component

Plain RSC — runs on the server, no directive needed.

```tsx
// App.tsx
export default function App() {
  return <h1>Hello from a Server Component</h1>;
}
```

### 2. Register the loader

`createReactLoader(options)` returns `{ load, resolve }` — Node ESM module
hooks. The only required option is `moduleID`, which maps an on-disk module
to the id baked into each emitted `registerClientReference` /
`registerServerReference` (i.e. where the client will fetch that chunk from).

```js
// register.mjs
import { register } from "node:module";
import { createReactLoader } from "react-server-loader/loader";

const { load } = createReactLoader({
  // Map the absolute file path to a hosted module id. This trivial policy
  // strips the project root so ids are project-relative; a real framework
  // points these at wherever it serves client chunks.
  moduleID: (filePath) => filePath.replace(process.cwd(), ""),
});

register(load, import.meta.url);
```

`moduleID` receives `(filePath, source, isClientByDirective)` and returns a
string; the example uses only the first argument. The loader also accepts
`logger`, `verbose`, `onTransform`, and a `loader` transport-contract
override — see the [loader options](./api-reference.md#createreactloaderoptions).

### 3. Render the tree to an RSC stream

`renderToPipeableStream(model, moduleBasePath, options?)` comes from
`react-server-loader/server`. It returns `{ pipe, abort }`; `pipe` takes any
Node writable and writes the RSC payload to it.

```tsx
// server.tsx — runs under --conditions react-server
import { renderToPipeableStream } from "react-server-loader/server";
import App from "./App.js";

// moduleBasePath is the root the client references resolve against —
// it must line up with the moduleBaseURL you pass on the decode side.
const { pipe } = renderToPipeableStream(<App />, "/");

// `destination` is any Node Writable (an HTTP response, a PassThrough, …).
pipe(destination);
```

### 4. Decode the stream into a React tree

`createFromNodeStream(stream, moduleRootPath, moduleBaseURL, options?)` comes
from `react-server-loader/client`. It returns a promise that resolves to the
React tree. Note it takes **two** path arguments — the on-disk module root
and the URL base the client fetches modules from:

```tsx
// client.tsx
import { createFromNodeStream } from "react-server-loader/client";

// moduleRootPath: on-disk root the references were emitted relative to.
// moduleBaseURL:  the URL prefix the client fetches client modules from.
const root = await createFromNodeStream(rscStream, "/", "/");
// `root` is the decoded React tree — render it, or React.use() it
// inside a component.
```

`react-server-loader/client` resolves to the Node transport
(`/client.node`) under Node and to the browser transport
(`/client.browser`) elsewhere, so the same import works on both sides of a
worker boundary.

### 5. Run it

The server must run under the `react-server` condition and import the loader
first:

```bash
node --import ./register.mjs --conditions=react-server server.js
```

- `--import ./register.mjs` installs the loader before your code runs, so
  directive modules are transformed on import.
- `--conditions=react-server` makes `react` and `react-server-dom-esm`
  resolve to their server builds; the transport throws without it.

The **client/decode** side runs without `--conditions react-server`.

## Client and server components

A module opts into the client boundary with a top-level `"use client"`
directive; a server-action module uses `"use server"`. The loader detects
these on import and rewrites them into the
`registerClientReference` / `registerServerReference` shape the transport
expects at runtime — you don't call those registration functions yourself.

```tsx
// Counter.tsx
"use client";
import { useState } from "react";

export function Counter() {
  const [n, setN] = useState(0);
  return <button onClick={() => setN(n + 1)}>{n}</button>;
}
```

Importing `Counter` from a server component produces a client reference (a
placeholder the client resolves), not the live component — that's the RSC
boundary doing its job.

## Where to go next

- [Versioning](./versioning.md) — the two trains and the peer-dependency
  contract.
- [Loader options](./api-reference.md#createreactloaderoptions) — `logger`,
  `verbose`, `onTransform`, transport-contract overrides.
- [Integrating into a bundler or framework](./integrating.md) — using the
  directive and transformer primitives directly in a `transform` hook.
- The full public surface is listed under
  [Subpaths](../README.md#subpaths).
