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
support. The package follows React's own transport conventions (the same
ones `react-server-dom-webpack` / `react-server-dom-parcel` publish):

- **stable** → version `19.x.y`, `react`/`react-dom` peer `^19.x.y`
- **experimental** → version `0.0.0-experimental-<sha>-<date>`,
  `react`/`react-dom` peer pinned to that **exact** string

So on the stable train any matching React 19.x satisfies the peer and the
install just works. The experimental train is stricter: its peer names the
**exact** `0.0.0-experimental-<sha>-<date>` it was vendored from, so you
must install that same React build — check which one with:

```bash
npm view react-server-loader@experimental peerDependencies
npm install react@<that-exact-version> react-dom@<that-exact-version>
```

The `react@experimental` dist-tag moves daily, so it only lines up with
`react-server-loader@experimental` when the two are published in lockstep
(see the release notes below). When in doubt, pin the exact version.

`react-server-loader`'s version tracks React's exactly — install the
`react-server-loader@<your-react-version>` train, or just use the
`@latest` / `@experimental` dist-tags above.

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

| React | `react-server-loader` | npm dist-tag |
| --- | --- | --- |
| `19.0.0` (stable) | `react-server-loader@19.0.0` | `latest` |
| `19.x.y` (stable) | `react-server-loader@19.x.y` | `latest` |
| `0.0.0-experimental-<sha>-<date>` | `react-server-loader@0.0.0-experimental-<sha>-<date>` | `experimental` |

Each published version pins its `react`/`react-dom` **peerDependencies**
to the exact React build it vendored `react-server-dom-esm` from, so
installing matching versions for `react`, `react-dom`, and
`react-server-loader` is enough — the peer-dep checker catches skew at
install time. Stable builds publish under the `latest` dist-tag and
experimental builds under `experimental`, so the two trains never move
each other's tag.

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

## Status

The package is in active development. Public API is still settling — the
top-level `createReactLoader` and the `react-server-loader/directives`
subpath are stable; the `react-server-loader/transformer` surface may
narrow as the public-facing pieces separate from internal helpers.

## License

MIT
