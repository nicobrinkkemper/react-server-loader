# API reference

Per-subpath reference for the public API of `react-server-loader` (rsl).

rsl is React, packaged with a native-ESM workflow in mind. It bundles, for
ESM/RSC: a vendored `react-server-dom-esm` transport, a directive engine
(`"use client"` / `"use server"` detection), source-to-source transformer
primitives, and a Node ESM loader factory.

Each entry point is a separate package subpath. Import only from the subpaths
listed here — they are the supported, consumer-facing surface.

| Subpath | What it gives you |
|---|---|
| [`react-server-loader/loader`](#react-server-loaderloader) | `createReactLoader` — Node ESM `load`/`resolve` hooks |
| [`react-server-loader/directives`](#react-server-loaderdirectives) | directive detection helpers |
| [`react-server-loader/transformer`](#react-server-loadertransformer) | `createTransformer`, `parse` |
| [`react-server-loader/server`](#transport-serverclientstatic) | vendored transport — server surface |
| [`react-server-loader/client`](#transport-serverclientstatic) | vendored transport — client surface |
| [`react-server-loader/static`](#transport-serverclientstatic) | vendored transport — static/prerender surface |
| [`react-server-loader`](#root-re-exports) | re-exports the full public surface |

For the conceptual picture, start with the [README](../README.md). Implementation
details live under [`docs/internals/`](internals/).

---

## `react-server-loader/loader`

The Node ESM loader layer. `createReactLoader` builds `load` and `resolve` hooks
that plug into [`node:module#register`](https://nodejs.org/api/module.html#moduleregisterspecifier-parenturl-options)
or `--experimental-loader`, converting `"use client"` / `"use server"` modules
into the contract the transport expects at runtime.

### `createReactLoader(options)`

```ts
function createReactLoader(options: CreateReactLoaderOptions): {
  load: LoadHook;
  resolve: ResolveHook;
};
```

Returns Node module-customization hooks. `load` does the work; `resolve` is a
pass-through today.

#### Options

| Option | Type | Required | Description |
|---|---|---|---|
| `moduleID` | `(filePath: string, source: string, isClientByDirective: boolean) => string` | yes | Maps the file path to the hosted module ID emitted inside the transformed module's `registerClientReference` / `registerServerReference` calls. The answer is consumer-specific — there is no universal default, so rsl requires you to supply it. |
| `loader` | `Partial<LoaderConfig>` | no | Transport-contract override. Defaults to the React-RSC shape published in `react-server-dom-esm`. Override the register-reference names, transport import paths, directive matchers, etc. to wire a different transport. |
| `onTransform` | `(info: { url: string; filePath: string; transformedId: string; source: string; isServer: boolean; isClient: boolean }) => void` | no | Fired for every module the loader identifies as an RSC boundary, after the transform runs. `source` is the transformed output. Useful for upstream orchestration (worker messaging, build manifests). The loader does not inspect the return value. |
| `logger` | `Logger` | no | Logger backend. Defaults to `CONSOLE_LOGGER` when `verbose` is `true`, otherwise `NULL_LOGGER`. |
| `verbose` | `boolean` | no | Print per-module trace lines via the logger. Defaults to `false`. |

> Note: the `moduleID` callback receives `(filePath, source, isClientByDirective)`.
> Many callers only need the first argument.

#### Example

```js
// register.mjs
import { register } from "node:module";
import { createReactLoader } from "react-server-loader/loader";

const { load, resolve } = createReactLoader({
  moduleID: (filePath) => filePath.replace(process.cwd(), ""),
});

register(load, import.meta.url);
```

Run your entry under the `react-server` condition so the server surface resolves:

```bash
node --conditions react-server --import ./register.mjs ./server-entry.mjs
```

### Logging

The loader (and the directive/transformer engines) take a `Logger`. rsl ships
two backends; you can also pass your own.

```ts
interface Logger {
  info(msg: string, options?: unknown): void;
  warn(msg: string, options?: unknown): void;
  error(msg: string, options?: unknown): void;
}
```

| Export | Behaviour |
|---|---|
| `CONSOLE_LOGGER` | Maps `info` → `console.log`, `warn` → `console.warn`, `error` → `console.error`. |
| `NULL_LOGGER` | No-op. Silences all engine output. |

```ts
import { CONSOLE_LOGGER, NULL_LOGGER, type Logger } from "react-server-loader/loader";

createReactLoader({ moduleID, logger: NULL_LOGGER }); // quiet
createReactLoader({ moduleID, verbose: true });        // CONSOLE_LOGGER by default
```

---

## `react-server-loader/directives`

The directive engine: pure functions that decide whether a module declares a
React Server Components boundary directive and where it sits. No transport, no
bundler assumptions.

### `detectClientModule(opts)`

```ts
function detectClientModule(opts: {
  source?: string;
  moduleId?: string;
  parseFn?: ParseFn;
}): boolean;
```

Returns `true` when a module is a React **client** component. A module qualifies
when **either**:

1. its `moduleId` matches the `.client.[cm]?[jt]sx?` filename convention
   (`Foo.client.tsx`, a standalone `client.tsx` entry), or
2. its `source` declares a top-of-file `"use client"` directive — leading
   whitespace, comments, and a `"use strict"` prologue are tolerated above it.

Substring matches against "client" in identifiers, import paths, comments, or
directory names are deliberately rejected.

| Field | Type | Description |
|---|---|---|
| `source` | `string` | Module source. If absent/empty, only the filename check applies. |
| `moduleId` | `string` | Module identifier / file path. If absent, only the source check applies. |
| `parseFn` | `(source, options?) => Program` | Optional AST producer. When supplied (e.g. a bundler's `this.parse`), detection uses the JSX/TS-aware AST path; when omitted it falls back to a parser-free char scanner. Both paths agree on well-authored modules. |

```ts
import { detectClientModule } from "react-server-loader/directives";

detectClientModule({ source: '"use client";\nexport const x = 1;' }); // true
detectClientModule({ moduleId: "src/Button.client.tsx" });           // true
detectClientModule({ source: "const clientId = 1;" });               // false
```

### `sourceHasTopLevelClientDirective(source)`

```ts
function sourceHasTopLevelClientDirective(source: string): boolean;
```

The parser-free core of the source check used by `detectClientModule`. Scans raw
source text (including untranspiled TSX that acorn can't parse) for a
top-of-file `"use client"` directive, applying React's structural contract:
leading whitespace, line/block comments, and a leading `"use strict"` prologue
are skipped; the directive must be the first real statement. Anything else
(an import, a variable, the word "client" in a comment or identifier) yields
`false`.

```ts
import { sourceHasTopLevelClientDirective } from "react-server-loader/directives";

sourceHasTopLevelClientDirective('"use strict";\n"use client";'); // true
sourceHasTopLevelClientDirective('import x from "y";\n"use client";'); // false
```

### `analyzeModule(source, options?)`

```ts
function analyzeModule(
  source: string,
  options?: DirectiveOptions
): Promise<ParseResult>;
```

Parses a module and returns the parse result enriched with directive
information. On success the resolved value carries `type: "success"`, the
`ast`, `code`, optional `map`, collected `exports`, and `directiveInfo`
(file-level directive, function-level `"use server"` directives, and any
placement warnings).

#### `DirectiveOptions`

| Field | Type | Description |
|---|---|---|
| `verbose` | `boolean` | Gate the engine's `logger.info` traces. Default `false`. |
| `logger` | `Logger` | Sink for traces/warnings. Defaults to `NULL_LOGGER`. |
| `loader` | `{ parse?: ParseFn; getDirectiveType?: GetDirectiveTypeFn }` | Supply an AST (`parse`) instead of the built-in acorn parse, and/or override the directive-string → `"client" \| "server"` mapping (`getDirectiveType`). Defaults map `"use client"`/`"use server"` per React's contract. |
| `tolerateLeadingCode` | `(source: string) => boolean` | Host predicate. Return `true` when leading code *before* a file-level directive is expected — e.g. a bundler that prepends imports — to suppress the "directive must be at the top of the file" warning. Defaults to strict (no tolerance): rsl ships no bundler-specific assumptions, so the host owns this policy. |

```ts
import { analyzeModule } from "react-server-loader/directives";

const result = await analyzeModule('"use client";\nexport function Btn() {}');
if (result.type === "success") {
  result.directiveInfo.fileLevel; // { type: "client", range: [...] }
}
```

---

## `react-server-loader/transformer`

Source-to-source transformer primitives. Given a directive-bearing module, they
produce transformed source with the matching `registerClientReference` /
`registerServerReference` calls injected — the shape the transport expects at
runtime. Bundler- and runtime-agnostic.

### `createTransformer({ options, ... })`

```ts
const createTransformer: TransformerFactory;
```

Builds a transform function. Call the factory once with configuration, then call
the returned function per module.

```ts
const transform = createTransformer({
  options: {
    verbose,         // boolean
    loader,          // LoaderConfig (transport contract)
    logger,          // Logger
    panicThreshold,  // "none" | "critical_errors" | "all_errors"
    moduleBase,      // string
    tolerateLeadingCode, // (source: string) => boolean
  },
});
```

The factory accepts:

| Field | Type | Description |
|---|---|---|
| `options` | `Pick<TransformOptions, "verbose" \| "loader" \| "panicThreshold" \| "logger" \| "moduleBase" \| "tolerateLeadingCode">` | Transformer configuration (see [`TransformOptions`](#transformoptions)). |
| `isServerEnvironment` | `boolean` | Whether to emit for the `react-server` environment. Defaults to auto-detection of the `react-server` condition. |
| `forceServerFunction` | `boolean` | Force server-reference output regardless of directives (testing/advanced). |
| `forceClientComponent` | `boolean` | Force client-reference output regardless of directives (testing/advanced). |

The returned function:

```ts
(source: string, moduleId: string, transformedModuleId?: string)
  => Promise<TransformResult>;
```

`TransformResult` is `{ code: string; map: RawSourceMap | null }`. When
`transformedModuleId` is omitted it is derived from `loader.moduleID(moduleId)`,
falling back to `moduleId`.

```ts
import { createTransformer } from "react-server-loader/transformer";

const transform = createTransformer({ options: { verbose: false } });
const { code, map } = await transform(
  '"use client";\nexport function Btn() {}',
  "/abs/src/Btn.tsx",
  "/src/Btn.tsx"
);
```

> `createReactLoader` builds and drives a transformer for you. Reach for
> `createTransformer` directly only when integrating rsl into another build
> pipeline (a Vite `transform` hook, a Webpack loader, etc.).

### `parse(source)`

```ts
function parse(source: string): {
  ast: Program;
  code: string;
  map: { url: string; start: number; end: number; lines: number } | null;
};
```

acorn-based module parse, shaped to match Rollup's `this.parse` return. Strips a
trailing `//# sourceMappingURL=` comment from `code` and reports its location in
`map` (or `map: null` when none is present). `ast` is an acorn `Program`.

```ts
import { parse } from "react-server-loader/transformer";

const { ast, code, map } = parse(source);
```

### `transformModule(...)`

```ts
function transformModule(
  source: string,
  moduleId: string,
  transformedModuleId: string,
  parseResult: ParseResult,
  options: TransformOptions
): Promise<TransformResult>;
```

The lower-level transform entry that `createTransformer` calls once a module has
been parsed and classified. It takes a `ParseResult` (from
[`analyzeModule`](#analyzemodulesource-options) or `parse` + directive analysis)
plus `TransformOptions`, and returns `{ code, map }`. Prefer `createTransformer`
unless you are managing parsing and classification yourself.

### `TransformOptions`

Configuration consumed by the transformer.

| Field | Type | Description |
|---|---|---|
| `loader` | `LoaderConfig` | Transport contract: register-reference names, transport import paths, directive matchers, `moduleID` mapping. |
| `verbose` | `boolean` | Per-module trace logging. |
| `logger` | `Logger` | Logging backend. |
| `panicThreshold` | `"none" \| "critical_errors" \| "all_errors"` | How directive-placement warnings escalate. `"none"` downgrades them to warnings in development; otherwise a misplaced directive throws. |
| `moduleBase` | `string` | Base path used when resolving emitted module IDs. |
| `tolerateLeadingCode` | `(source: string) => boolean` | Host predicate that suppresses the "directive must be at the top" warning when a bundler prepends leading code. Default: strict. |
| `forceServerFunction` | `boolean` | Force server-reference output (advanced). |
| `forceClientComponent` | `boolean` | Force client-reference output (advanced). |
| `isServerEnvironment` | `boolean` | Emit for the `react-server` environment. |

---

## Transport: `/server`, `/client`, `/static`

These subpaths re-export the vendored `react-server-dom-esm` transport. React
does not publish this package to npm, so rsl vendors it and binds its version to
the React version it was built against. (See [versioning](./versioning.md).)

### `react-server-loader/server` (and `/server.node`)

The server transport surface. **Requires the `react-server` condition**
(`node --conditions react-server`).

```ts
import {
  renderToPipeableStream,
  registerClientReference,
  registerServerReference,
  decodeReply,
  createTemporaryReferenceSet,
} from "react-server-loader/server";
```

### `react-server-loader/client` (and `/client.node`, `/client.browser`)

The client transport surface. `react-server-loader/client` resolves to the
Node build under the `node` condition and the browser build otherwise;
`/client.node` and `/client.browser` pin a specific build.

```ts
import {
  createFromNodeStream,
  createServerReference,
} from "react-server-loader/client";
```

### `react-server-loader/static` (and `/static.node`)

Re-exports the server surface for this React build — the static/prerender
entry of the vendored transport.

> These are the exports of the vendored React transport, surfaced as-is. Their
> behaviour and signatures track the underlying React build; consult React's RSC
> documentation for usage.

---

## Root re-exports

```ts
import {
  createReactLoader,
  detectClientModule,
  createTransformer,
} from "react-server-loader";
```

The root entry re-exports the full public surface for convenience —
`createReactLoader`, `detectClientModule`, `sourceHasTopLevelClientDirective`,
`analyzeModule`, `createTransformer`, `parse`, `transformModule`,
`DEFAULT_LOADER_CONFIG`, and the `CONSOLE_LOGGER` / `NULL_LOGGER` backends.
The transport (`/server`, `/client`, `/static`) is only on its subpaths.

---

## See also

- [README](../README.md) — overview and quick start
- [`docs/`](.) — consumer guides
- [`docs/internals/`](internals/) — implementation details
