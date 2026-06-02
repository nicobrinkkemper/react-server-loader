# react-server-loader

Loader-side tooling for React Server Components in ESM environments.

> **Scope:** use React, but with a native-ESM workflow in mind. Anything
> that helps you run React (and RSC) in pure ESM belongs here; shipping a
> *copy* of React does not — `react`/`react-dom` always come from the
> consumer.

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

`react-server-loader` ships two trains, one per React release channel.
Pick the one matching the React you build against — the versions line up
so the install "just works" and the peer-dep checker flags any skew.

**Stable React 19** (the `latest` tag):

```bash
npm install react-server-loader react react-dom
```

**Experimental React** (the `experimental` tag — newest RSC features):

```bash
npm install react-server-loader@experimental react@experimental react-dom@experimental
```

Either way you need a React **19+** build with React Server Components
support. The two trains version differently — see *Versioning* below for
the full rationale:

- **stable** → version `<ReactVersion>` (e.g. `19.2.7`), `react`/`react-dom`
  peer `^<ReactVersion>` (e.g. `^19.2.7`). Any matching React 19.x at or above
  it satisfies the install.
- **experimental** → version `0.0.0-experimental-<sha>-<date>`,
  `react`/`react-dom` peer pinned to that **exact** string.

The experimental train is stricter: its peer names the exact
`0.0.0-experimental-<sha>-<date>` it was vendored from, so install that
same React build — check which one with:

```bash
npm view react-server-loader@experimental peerDependencies
npm install react@<that-exact-version> react-dom@<that-exact-version>
```

The `react@experimental` dist-tag moves daily, so it only lines up with
`react-server-loader@experimental` when the two were built from the same
commit. When in doubt, pin the exact version. Or just use the
`@latest` / `@experimental` dist-tags for the newest of each train.

## Use it

`react-server-loader` ships the pieces to run RSC in pure ESM: the
**transport** (`react-server-dom-esm`, which React doesn't publish), a
**loader** that transforms `"use client"` / `"use server"` modules on
import, and the **directive + transformer** primitives those are built on.
The common path uses the loader and transport together; bundler and
framework authors reach for the primitives directly.

### Render RSC with no bundler

Two steps — register the loader so directive modules transform on import,
then render and decode with the transport.

```ts
// register.mjs — install the loader
import { register } from "node:module";
import { createReactLoader } from "react-server-loader/loader";

const { load } = createReactLoader({
  // Maps an on-disk module to the id baked into each emitted
  // `registerClientReference` — i.e. where the client will fetch it from.
  moduleID: (filePath) => filePath.replace(process.cwd(), ""),
});
register(load, import.meta.url);
```

```tsx
// server.js — render a server component tree to an RSC stream
import { renderToPipeableStream } from "react-server-loader/server";
import App from "./App.js";

const { pipe } = renderToPipeableStream(<App />, "/client/");
pipe(response); // a Node writable — the RSC payload
```

```ts
// client.js — decode the stream back into a React tree
import { createFromNodeStream } from "react-server-loader/client";

const root = await createFromNodeStream(rscStream, "/client/");
```

```bash
# the server runs under the react-server condition so react and the
# transport resolve to their server builds
node --import ./register.mjs --conditions=react-server server.js
```

### Inside a bundler plugin — the primitives

```ts
import { detectClientModule } from "react-server-loader/directives";
import { createTransformer } from "react-server-loader/transformer";

// In your bundler's transform hook:
if (detectClientModule({ source, moduleId: id })) {
  const transformer = createTransformer({
    options: { moduleID: yourHostedPathPolicy },
  });
  return transformer(source, id, hostedID);
}
```

### Just the directive engine

```ts
import {
  detectClientModule,
  sourceHasTopLevelClientDirective,
} from "react-server-loader/directives";
```

For tooling that only needs to identify RSC boundaries — type-checkers,
lint rules, build-graph analysers — without committing to a transform.

## Subpaths

| Subpath | Surface |
| --- | --- |
| `react-server-loader/loader` | `createReactLoader` → Node ESM `load` / `resolve` hooks. |
| `react-server-loader/directives` | Directive engine: `detectClientModule`, `sourceHasTopLevelClientDirective`, `analyzeModule`. Pure analysis, no transport dependency. |
| `react-server-loader/transformer` | Source-to-source transform: `createTransformer`, `parse`, `transformModule`. |
| `react-server-loader/server` (`/server.node`) | Vendored transport, server: `renderToPipeableStream`, `registerClientReference`, `decodeReply`, … (needs `--conditions react-server`). |
| `react-server-loader/client` (`/client.node`, `/client.browser`) | Vendored transport, client: `createFromNodeStream`, `createServerReference`. |
| `react-server-loader/static` (`/static.node`) | Vendored transport, static entry. (In this React build it re-exports the server surface — `react-server-dom-esm` ships no separate static module.) |
| `react-server-loader` | Re-exports the headline API (`createReactLoader`, `detectClientModule`, `createTransformer`). |

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

**`react-server-loader`'s version === the `react-server-dom-esm` (React)
version it vendors.** The transport is hard-bound to one React build's
internals — it reads React's `ReactSharedInternals` and throws on a
"React Element from an older version of React" if paired with a different
copy. So the version is the unambiguous signal of *which React's internals*
the transport expects; it must match, and the peer must keep consumers on a
compatible React. This is exactly the convention React's own published
transports (`react-server-dom-webpack` / `-parcel`) use.

| train | version | `react`/`react-dom` peer | dist-tag |
| --- | --- | --- | --- |
| **stable** | `<ReactVersion>` (e.g. `19.2.7`) | `^<ReactVersion>` (e.g. `^19.2.7`) | `latest` |
| **experimental** | `0.0.0-experimental-<sha>-<date>` | that **exact** string | `experimental` |

`build-rsl.sh` stamps both onto rsl's `package.json` from the React it just
vendored. The two dist-tags never move each other's pointer, so the trains
coexist.

### Stable

Version and `react`/`react-dom` peer both come from the vendored React:
version `19.2.7`, peer `^19.2.7`. React keeps the RSC ABI stable within a
major, so the `^` floor at the vendored build is safe up to the next major —
the same range `react-server-dom-webpack@19.2.7` ships. To cut a stable
release, rebuild against a React tag (`--react-ref v19.2.8`); the version and
peer follow the vendored transport automatically.

### Experimental

Mirrors React's own experimental format — `0.0.0-experimental-<sha>-<date>`,
where `<sha>` is the 8-char React commit and `<date>` its committer date —
and pins `react`/`react-dom` to that **exact** string. The pin must be exact:
experimental internals change per commit, so a wider range would let a
consumer pair this transport with a *different* experimental React and crash
on the `ReactSharedInternals` mismatch. A `0.0.0-experimental-…` version
sorts below `1.0.0`, so it never satisfies a `^19` range — the experimental
train stays opt-in. Patch a build (an rsl fix against the same React commit)
by republishing with a trailing `.N`, which sorts *above* the original.

## Building a release

`scripts/build-rsl.sh` clones React (or uses the sibling checkout at
`../react` if present), runs React's own build under the requested
`RELEASE_CHANNEL`, vendors `react-server-dom-esm` into `vendor/`, and
writes the publishable shim entry points. Typical local invocation:

```bash
# experimental (default — builds against React main)
./scripts/build-rsl.sh

# stable, against a specific React tag
./scripts/build-rsl.sh --channel stable --react-ref v19.0.0

# point at an arbitrary React checkout
./scripts/build-rsl.sh --react-dir /path/to/react
```

The build script needs `yarn`, `node >= 22`, and `java` (React's build
runs Closure Compiler). It stamps the vendored transport's `package.json`
with the channel-correct version and `react`/`react-dom` peer range
(see *Versioning* above).

**Publishing is done locally — no npm token ever lives on GitHub.** The
`.github/workflows/publish.yml` workflow ("Build + pack") runs the same
pipeline on a clean checkout and uploads the packed tarball as an
artifact; it never publishes. To cut a release, build (locally or via the
workflow), then publish that tarball from your own machine:

```bash
# build locally...
./scripts/build-rsl.sh --channel stable --react-ref v19.2.7
npm pack
# ...or download the workflow's artifact instead, then:
npm publish ./react-server-loader-<version>.tgz --access public --tag <latest|experimental>
```

Use `--tag experimental` for the experimental train so it never moves
`latest`. The workflow's run Summary prints the exact command for the
version it built.

## Public API

The supported surface is the subpaths documented under *Subpaths* above and
the symbols named there:

- `react-server-loader/loader` — `createReactLoader`
- `react-server-loader/directives` — `detectClientModule`,
  `sourceHasTopLevelClientDirective`, `analyzeModule`
- `react-server-loader/transformer` — `createTransformer`, `parse`,
  `transformModule`
- `react-server-loader/server` · `/client` · `/static` — the vendored
  `react-server-dom-esm` transport
- `react-server-loader` — re-exports the headline three (`createReactLoader`,
  `detectClientModule`, `createTransformer`)

Everything else (AST type-guards, low-level transform helpers) is internal,
not exported, and may change without a major bump. The transport tracks
React's RSC API for the version it was built against (see *Versioning*).

## License

MIT
