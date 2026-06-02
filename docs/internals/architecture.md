# Architecture

How react-server-loader (rsl) is layered, and how a source module flows
through those layers to become RSC-ready output.

This is an internals document — it names private helpers and walks the
control flow. For the consumer-facing surface, see the
[README](../../README.md) and the [consumer guides](../).

## The four layers

rsl is a stack of four cooperating layers. Each lower layer is usable on
its own; each higher layer composes the ones beneath it.

```
┌─────────────────────────────────────────────────────────────┐
│  4. Loader            createReactLoader → { load, resolve }   │
│       src/loader/        Node ESM hooks; orchestrates 1–3     │
├─────────────────────────────────────────────────────────────┤
│  3. Transformer       createTransformer → transform fn        │
│       src/transformer/   source → source with register calls  │
├─────────────────────────────────────────────────────────────┤
│  2. Directive engine  analyzeModule / detectClientModule      │
│       src/directives/    "use client" / "use server" + AST    │
├─────────────────────────────────────────────────────────────┤
│  1. Vendored transport   react-server-dom-esm                 │
│       vendor/            renderToPipeableStream, register*,    │
│                          createFromNodeStream, …              │
└─────────────────────────────────────────────────────────────┘
```

Read the stack two ways:

- **Build time** flows top-down: the loader calls the transformer, which
  calls the directive engine. The transport (layer 1) is not invoked at
  build time — it is the *target*. The transformer emits calls to
  `registerClientReference` / `registerServerReference`, names that come
  from the transport's contract.
- **Run time** is layer 1 alone: the transformed module, once loaded,
  executes its injected `register*` calls and the renderer
  (`renderToPipeableStream`) walks the resulting reference graph.

### 1. Vendored transport — `vendor/react-server-dom-esm/`

React does not publish `react-server-dom-esm` to npm, so rsl vendors a
build of it (`vendor/react-server-dom-esm/`) and re-exports its surface
through the package's `./server`, `./client`, and `./static` subpaths.

This layer is not authored in rsl — it is produced by
`scripts/build-rsl.sh`, which vendors the transport and stamps
`package.json`. Because the transport binds directly to React internals
(`ReactSharedInternals`) and throws on a version mismatch, **the
`react`/`react-dom` peer pins the exact React the transport was vendored
from** (the package version itself is rsl's own, `@types`-style — see
[vendoring-and-publishing](./vendoring-and-publishing.md#versioning)).
Everything above this layer is written to emit exactly the call shapes this
transport expects to find at runtime.

The transformer never imports this layer; it only emits *references* to
it by name. The names are configurable (see `LoaderConfig` below), and
they default to the transport's actual exports:
`registerClientReference`, `registerServerReference`, with the import
path `react-server-dom-esm/server` (or `…/server.node`).

### 2. Directive engine — `src/directives/`

The smallest reusable piece: pure functions that decide whether a module
declares a React Server Components boundary and where the directive sits.

Two entry points matter to the layers above:

- **`detectClientModule({ source, moduleId, parseFn? })`** — a fast,
  boolean "is this a client module?" check. It short-circuits in this
  order:
  1. filename convention (`*.client.tsx`, a standalone `client.tsx`
     entry) — deterministic, no source needed;
  2. cheap substring pre-filter — if the source contains no `use client`
     at all, it is definitely not a client module, so neither the parser
     nor the scanner runs;
  3. AST path when a `parseFn` is supplied (a bundler passing its own
     parser): parse, then inspect directives via `analyzeDirectives`,
     rejecting a misplaced (`"must be at the top of the file"`) directive;
  4. parser-free fallback `sourceHasTopLevelClientDirective(source)` —
     the same structural contract without a parser.

- **`analyzeModule(source, options?)`** — the full pass. It parses (via
  `loader.parse` if provided, else the built-in acorn `parse`), collects
  exports (`getExports`, unless the parser already returned them), runs
  `analyzeDirectives`, and returns a `ParseResult`:

  ```ts
  // ParseResult on the success path carries:
  { type: "success", ast, code, map, exports, directiveInfo }
  ```

  `directiveInfo` holds `fileLevel`, `functionLevel`, and `warnings`
  (e.g. a directive placed after real code). The transformer consumes
  this structure rather than re-parsing.

The engine's options (`DirectiveOptions`) expose only what it inspects:
`verbose`, `logger`, `loader.parse`, `loader.getDirectiveType`, and the
host predicate `tolerateLeadingCode` (suppresses the "directive must be
at the top" warning when a bundler legitimately prepends code). rsl ships
no bundler-specific assumptions here — the host owns that policy.

### 3. Transformer — `src/transformer/`

Source-to-source. Given a directive-bearing module, it produces a
transformed module with the matching `register*` calls injected — the
shape the transport (layer 1) expects at runtime.

`createTransformer({ options, … })` returns a function
`(source, moduleId, transformedModuleId?) => Promise<TransformResult>`,
where `TransformResult` is `{ code, map }`. The factory captures
`verbose`, `logger`, and the `loader` config; the returned function is
the per-module workhorse.

Control flow inside the returned function:

1. **Fast path** — `findDirectiveMatches(source)` scans for directives
   without a full parse. With no `use client` / `use server` present, the
   transformer skips parsing entirely and the behaviour branches on
   environment (see below).
2. **Environment branch** — behaviour depends on whether the process runs
   under the `react-server` condition (`isServerEnvironment`, defaulting
   to `isReactServerCondition()` from `src/runtime/env.ts`):
   - *server environment*: client modules become
     `registerClientReference` stubs; server modules pass through
     `transformServerModule`.
   - *non-server environment*: directives are stripped
     (`transformNonServerEnvironment`), and directive-free server
     components that aren't client-by-name and aren't in `node_modules`
     are hidden (so a server component can't leak into a client/SSR
     bundle).
3. **Analyze** — for directive-bearing modules it calls
   `analyzeModule` (layer 2) for the full `ParseResult`, surfaces or
   throws directive warnings depending on `panicThreshold` and
   `NODE_ENV` (`getNodeEnv()`), then dispatches to `transformModule`,
   which routes to `transformClientModule` / `transformServerModule` /
   `transformNonServerEnvironment` based on the resolved
   `forceClientComponent` / `forceServerFunction` flags and the
   environment.

The individual `transform*` primitives, plus the AST-surgery helpers
(`transformWithAcornLoose`, `removeRanges`, `removeDirectives`,
`createSourceMap`, `transformModuleIfNeeded`) are implementation details
of this layer — documented in this `internals/` tree, never in the
consumer docs.

The `LoaderConfig` (transport contract) is what makes the transformer
transport-agnostic. `DEFAULT_LOADER_CONFIG` targets `react-server-dom-esm`
(`registerClientReferenceName: "registerClientReference"`,
`importServerPath: "react-server-dom-esm/server"`, etc.); a host overrides
any subset to retarget the emitted calls.

### 4. Loader — `src/loader/`

The orchestration layer. `createReactLoader(options)` returns Node ESM
`{ load, resolve }` hooks for `node:module#register` (or
`--experimental-loader`).

```ts
const { load, resolve } = createReactLoader({
  moduleID: (filePath /*, source, isClientByDirective */) =>
    filePath.replace(process.cwd(), ""),
});
```

Inside `load`:

1. It calls `nextLoad` to obtain the raw source, normalising
   `string | Uint8Array` to a string.
2. **CJS-React rewrite** — under the `react-server` condition `react`
   resolves as CommonJS, so esbuild/tsx-produced
   `import { X } from "react"` named imports fail to resolve. The loader
   rewrites each to a default import plus a destructure. This applies to
   user code *and* `node_modules`, and runs even on plain (non-boundary)
   modules.
3. **Boundary detection** — client via `detectClientModule` (layer 2),
   plus an inline prologue-walking scanner for file-level `"use server"`;
   `LoaderConfig.isClientComponentCode` / `isServerFunctionCode` can
   widen either. Non-boundaries return the (possibly rewritten) source
   untouched.
4. **Transform** — it computes the hosted module ID via the consumer's
   required `moduleID` callback, runs the captured transformer (layer 3),
   fires the optional `onTransform` callback, and returns
   `{ ...result, source, map? }`.

`resolve` is currently a pass-through (`nextResolve`), reserved for
future import-map / hosted-path work.

The loader is where the public option surface lives: `moduleID`
(required), `loader` (a `Partial<LoaderConfig>` override), `logger`,
`verbose`, and `onTransform`. The two built-in logger backends
(`CONSOLE_LOGGER`, `NULL_LOGGER`) and the `Logger` type are re-exported
here too.

## Data flow: one source module to RSC output

The path a single client-component file takes through a server-side load:

```
  Foo.client.tsx  ("use client")
        │
        ▼  Node resolves & reads the file
  ┌───────────────┐
  │ load (layer 4)│  nextLoad → raw source
  └───────┬───────┘
          │  rewrite CJS `react` named imports
          ▼
  detectClientModule (layer 2)  ── client? ─▶ yes
          │
          │  moduleID(filePath, source, isClientByDirective)
          │     → transformedId  (the hosted ID)
          ▼
  ┌────────────────────┐
  │ transformer (3)    │  findDirectiveMatches → analyzeModule (2)
  │                    │  → transformModule → transformClientModule
  └─────────┬──────────┘
            │  emits, per export:
            │    registerClientReference(proxy, transformedId, name)
            ▼
  { code, map }  ──▶  load returns { source: code, map }
            │
            ▼  (run time, layer 1)
  react-server-dom-esm: renderToPipeableStream walks the
  registered references → RSC stream
```

For a server module (`"use server"`), step 3 routes through
`transformServerModule` and emits `registerServerReference` instead; the
transport later resolves those via `decodeReply` / the server-reference
machinery. In a non-server (client/SSR) environment the same transformer
instead strips directives, and directive-free server components are
hidden so they never reach the client.

## Where the public API sits

The audience firewall maps cleanly onto the layers. Consumer-facing
exports are a thin slice of each layer; everything else is internal.

| Subpath | Public (consumer) | Internal (this tree) |
|---|---|---|
| `react-server-loader` (root) | `createReactLoader`, `detectClientModule`, `createTransformer` | the rest of the re-exports — `transformModuleIfNeeded`, `transformWithAcornLoose`, `removeRanges`, `removeDirectives`, `createSourceMap`, etc. |
| `/loader` | `createReactLoader`, its option types, `Logger`, `CONSOLE_LOGGER`, `NULL_LOGGER` | — |
| `/directives` | `detectClientModule`, `sourceHasTopLevelClientDirective`, `analyzeModule` | `analyzeDirectives`, `findDirectiveMatches`, `getExports`, type guards, `processFunctionNode`, … |
| `/transformer` | `createTransformer`, `parse`, `transformModule` | `transformClientModule`, `transformServerModule`, `transformNonServerEnvironment`, `transformWithAcornLoose`, `removeRanges`, `removeDirectives`, `createSourceMap`, `transformModuleIfNeeded` |
| `/server`, `/client`, `/static` | the vendored transport surface | — (built by `scripts/build-rsl.sh`) |

> The root barrel (`src/index.ts`) physically re-exports many internal
> transformer primitives. Treat the headline three
> (`createReactLoader`, `detectClientModule`, `createTransformer`) as the
> root's *documented* surface — the firewall is a documentation contract,
> not an export-map restriction. See [the discrepancy note](#note) below.

## See also

- [README](../../README.md) — quick start.
- consumer guides under [`docs/`](../).
- `scripts/build-rsl.sh` — vendors the transport, stamps the version.
- `scripts/verify-release.sh` — gates a candidate tarball against vprs.

<a id="note"></a>
> **Internals note.** The `react-server-dom-esm` *transport* is not part
> of this repo's authored source; it lands in `vendor/` at build time.
> The architecture above describes how the rsl-authored layers (2–4)
> target it.
