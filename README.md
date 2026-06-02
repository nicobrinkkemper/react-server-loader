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
support. The two trains version differently — see *Versioning* below for
the full rationale:

- **stable** → version `19.<minor>.<rsl-patch>`, `react`/`react-dom` peer
  `>=<vendored React> <next minor>` (e.g. `>=19.2.7 <19.3.0`). Any matching
  React 19.2.x satisfies it, so the install just works.
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

`react-server-loader` carries two things that version on different clocks:
its **own code** (the directive engine, transformer, loader, shim
generation) and a **vendored `react-server-dom-esm`** built from a specific
React. React doesn't publish `react-server-dom-esm`, so we build and vendor
it — but rsl's own code can need a fix between React releases. The two
trains handle that differently.

| train | version | `react`/`react-dom` peer | dist-tag |
| --- | --- | --- | --- |
| **stable** | `19.<minor>.<rsl-patch>` (e.g. `19.2.0`, `19.2.1`) | `>=<vendored React> <next minor>` (e.g. `>=19.2.7 <19.3.0`) | `latest` |
| **experimental** | `0.0.0-experimental-<sha>-<date>` | `=` that exact string | `experimental` |

The two dist-tags never move each other's pointer, so the trains coexist.

### Stable — `@types`-style, rsl owns the patch

The **major.minor** tracks React's minor (`19.2.x` → React 19.2), but the
**patch** is `react-server-loader`'s own revision — exactly how
`@types/react@19.0.x` tracks React 19.0 while owning the `.x`. The peer
floors at the React build we vendored and caps at the next minor, so any
React 19.2.z (z ≥ vendored) satisfies it.

This exists because the version *can't* be React's exact version (`19.2.7`):
npm versions are immutable and nothing sorts between `19.2.7` and `19.2.8`,
so an rsl-only bug would be unshippable until React itself released. Owning
the patch slot fixes that.

**To cut a stable release (React refresh or an rsl-only fix):**

1. Bump `version` in `package.json` — increment the patch for the same
   React minor (`19.2.0` → `19.2.1`), or set `19.<newminor>.0` when moving
   to a new React minor. Every publish needs a fresh patch (npm versions are
   immutable); `build-rsl.sh` warns if major.minor has drifted from React.
2. Rebuild: `./scripts/build-rsl.sh --channel stable --react-ref vX.Y.Z`.
   It writes the peer floor from the React you vendored and keeps your
   `package.json` version.
3. `npm pack` and publish locally (see *Building a release*), `--tag latest`.

The version no longer encodes React's exact *patch* (the peer range and
this doc do) — the trade for being able to ship a fix any time.

### Experimental — exact snapshot of one React build

Mirrors React's own experimental format
(`0.0.0-experimental-<sha>-<date>`, where `<sha>` is the 8-char React commit
and `<date>` its committer date) and pins `react`/`react-dom` to that exact
string, so it lines up byte-for-byte with `react@experimental` built from
the same commit. `build-rsl.sh` derives both from the React checkout.

A `0.0.0-experimental-…` version sorts below `1.0.0`, so it can never
satisfy a `^19`/stable range — the experimental train stays opt-in. To
**patch** an experimental build (an rsl fix against the same React commit),
republish with a trailing `.N` — `0.0.0-experimental-<sha>-<date>.1` sorts
*above* the original, and the `experimental` dist-tag moves to it.

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
