# Transformer internals

> Audience: contributors to `react-server-loader`. For the consumer-facing
> surface (`createTransformer`, `parse`, `transformModule`, `TransformOptions`),
> see the [API reference](../api-reference.md). This document covers the
> private primitives those entry points compose, and is allowed to name the
> implementation functions that the audience firewall keeps out of consumer docs.

The transformer is the source-to-source half of `react-server-loader`. Given a
module's source text and an id, it decides whether the module crosses an RSC
boundary (`"use client"` / `"use server"`) and, if so, rewrites it into the
shape that `react-server-dom-esm` expects at runtime — `registerClientReference`
/ `registerServerReference` calls bound to a stable module id. It is bundler-
and runtime-agnostic: a Vite `transform` hook, a Webpack loader, and the Node
ESM `load` hook all drive the same primitives.

All files referenced below live in `src/transformer/`.

## Module map

| File | Role |
|------|------|
| `index.ts` | Re-exports the primitives and the default config / types. |
| `createTransformer.ts` | The orchestrator. Builds the closure that routes each module to the right transform path. |
| `defaults.ts` | `DEFAULT_LOADER_CONFIG`, `DEFAULT_CONFIG`, `DIRECTIVE_CONFIGS` — the transport contract. |
| `parse.ts` | `parse(source)` — acorn parse returning `{ ast, code, map }` (Rollup-shaped). |
| `transformModule.ts` | `transformModule` — dispatches to client/server/non-server transforms based on flags + environment. |
| `transformClientModule.ts` | `transformClientModule` — replaces a client module with `registerClientReference` stubs. |
| `transformServerModule.ts` | `transformServerModule` — strips `"use server"` directives and appends `registerServerReference` calls. |
| `transformNonServerEnvironment.ts` | `transformNonServerEnvironment` — strips directives only; no registrations. |
| `removeDirectives.ts` / `removeRanges.ts` | Range-based source surgery used to delete directive prologues. |
| `sourceMap.ts` | `createSourceMap` plus VLQ encoding and source-map URL helpers. |
| `transformModuleIfNeeded.ts` / `transformWithAcornLoose.ts` | Thin one-shot wrappers around `createTransformer`. |
| `types.ts` | `LoaderConfig`, `TransformOptions`, `TransformResult`, `TransformFunction`, `TransformerFactory`, `ParseFn`. |

## The `react-server` condition drives everything

The single most important input is **which environment we are in**. Node sets
the `react-server` resolution condition with `--conditions react-server` (or via
`NODE_OPTIONS`); servers rendering RSC run under it so that `react` and
`react-server-dom-esm` resolve to their server-side exports.

`createTransformer` defaults its `isServerEnvironment` parameter to
`isReactServerCondition()` (`src/runtime/env.ts`), which simply checks whether
`process.execArgv` joined with `NODE_OPTIONS` contains the string
`react-server`:

```ts
export function isReactServerCondition(): boolean {
  const argv = process.execArgv?.join(" ") ?? "";
  const nodeOpts = process.env["NODE_OPTIONS"] ?? "";
  return (argv + " " + nodeOpts).includes("react-server");
}
```

The flag can be overridden explicitly (tests pass `isServerEnvironment`
directly), but in a real build it is detected from the process. From here on,
"server environment" means this condition is active.

The behaviour split:

- **Server environment** (`isServerEnvironment === true`): boundary modules are
  rewritten into reference registrations. Client modules become
  `registerClientReference` stubs (their implementation is erased); server
  modules keep their implementation and gain `registerServerReference` calls.
- **Non-server environment** (client / SSR): boundary modules only have their
  directive prologue stripped (`transformNonServerEnvironment`). The
  implementation passes through unchanged. The `forceServerFunction` /
  `forceClientComponent` flags are only honoured here when *explicitly* passed
  (the testing path) — auto-detected directives fall through to directive
  removal.

`NODE_ENV` is a second, independent axis (`getNodeEnv()`), used for two things:
selecting the right `DEFAULT_CONFIG.RSC_LOADER` entry, and deciding whether a
directive-placement error may be downgraded to a warning (only in non-production
when `panicThreshold === "none"`).

## `DEFAULT_LOADER_CONFIG`: the transport contract

`defaults.ts` defines the contract the transformer follows when the caller does
not override it. The shape is `LoaderConfig` (`types.ts`); the consumer-facing
`loader` option is a `Partial<LoaderConfig>` merged over this.

Key fields and their defaults:

| Field | Default | Purpose |
|-------|---------|---------|
| `serverDirective` / `clientDirective` / `directivePattern` | regexes in `DIRECTIVE_PATTERNS` | Fast-path directive detection. |
| `allowedDirectives` | `DIRECTIVE_CONFIGS` | Placement rules + warning text per directive (see below). |
| `importServerPath` / `importClientPath` | `"react-server-dom-esm/server"` | Module specifier injected into rewritten code. |
| `registerClientReferenceName` | `"registerClientReference"` | Identifier injected for client stubs. |
| `registerServerReferenceName` | `"registerServerReference"` | Identifier injected for server registrations. |
| `isClientComponentByName` | `detectClientModule({ moduleId })` | Filename-convention fallback (`.client.tsx`) when no directive is present. |
| `isServerFunctionCode` | regex `(\.|\/)?server(\.|\/)?` over code/id | Heuristic for server-action files. |
| `parse` | `parse` from `parse.ts` | AST provider; a host may supply its own. |
| `mode` | `getNodeEnv()` | Which `NODE_ENV` this config represents. |
| `moduleID` | identity-as-string | Maps a file path to a stable runtime id. |

`DIRECTIVE_CONFIGS` encodes the placement rules:

- `client`: not function-level, must be at `index === 0` (the very first
  statement), else warns `'use client' directive is only allowed at the top of
  a file`.
- `server`: may be function-level; at file level it must be preceded only by
  whitespace/newlines, else warns `File-level directives must be at the top of
  the file, before any other code`.

`DEFAULT_CONFIG.RSC_LOADER` keys three variants by `NODE_ENV`:
`development` and `production` are `DEFAULT_LOADER_CONFIG` with the matching
`mode`; **`test` additionally rewrites both import paths to
`react-server-dom-esm/server.node`** to match React's internal test-mode wiring.
The per-environment transform helpers default their `loader` argument to
`DEFAULT_CONFIG.RSC_LOADER[getNodeEnv()]`, so calling them bare still resolves a
coherent contract.

## `createTransformer`: the orchestrator

`createTransformer({ options, forceServerFunction?, forceClientComponent?,
isServerEnvironment? })` returns an async function
`(source, moduleId, transformedModuleId?) => Promise<TransformResult>`. The
returned closure is the entry point everything else flows through.

A few implementation details worth knowing:

- **Closure state is reset per call.** `forceServerFunction` /
  `forceClientComponent` are captured at construction, but the returned function
  re-assigns them to their initial values at the top of every invocation. This
  is a deliberate fix for state pollution across calls — the flags are mutated
  during a call (e.g. set to `true` when a directive is found) and must not leak
  into the next module. `explicitForceServerFunction` /
  `explicitForceClientComponent` record whether the caller passed a value, so
  the auto-detected path and the explicit (testing) path can be distinguished
  later.
- **`transformedModuleId` defaults to `loader?.moduleID?.(moduleId) ?? moduleId`.**
  The caller may override it positionally; this is the id stamped into the
  emitted `registerClientReference` / `registerServerReference` calls.

### Fast path: no directives

Before parsing, the orchestrator calls `findDirectiveMatches(source)` (from the
directives package) and checks for any `client` / `server` match. If neither is
present it avoids a full parse and branches on environment:

- **Server env + `isClientComponentByName` matches** (e.g. a `.client.tsx` file
  with no explicit directive): set `forceClientComponent = true` and fall
  through to `transformModule` so the file is stubbed as a client reference.
- **Non-server env, not a client-by-name file, not in `node_modules`**: treat as
  a server-only component and **hide it** by returning the source unchanged
  (`{ code: source, map: null }`). The intent is that server components never
  load into a client/SSR graph; third-party `node_modules` and directive-bearing
  files are exempt.
- **Otherwise** (client/SSR): if directives were present they are removed via
  `transformNonServerEnvironment`; if the file is client-by-name it is run
  through the same path to normalise exports; else the source passes through.

> Note: inside this `hasClientDirective === false && hasServerDirective ===
> false` branch there are sub-branches guarded by `if (hasClientDirective ||
> hasServerDirective)` which are statically unreachable (both are already known
> false). They are dead code, not a behaviour the docs rely on.

### Directive path

When a directive *is* present, the orchestrator sets `forceClientComponent` /
`forceServerFunction` from the match types, then performs an
**already-transformed guard**: in a server environment for a client component,
if the source already contains the `registerClientReference` identifier, the
module was transformed once already — it logs a warning and returns the source
untouched. This makes the transform idempotent against double invocation.

### Parse, validate, dispatch

Both paths converge on `analyzeModule(source, { ...options, logger, loader })`
to produce the full `ParseResult` (AST + directive info + exports). Directive
**warnings** are then processed:

- In non-production with `panicThreshold === "none"`, each warning is logged
  with a code frame (line numbers, the offending directive underlined via
  `picocolors`) and execution continues.
- Otherwise the first warning is **thrown** as an `Error`, stopping compilation.
  This is the "panic" behaviour — directive misplacement is a hard error by
  default.

If the parse result is not `success`, the orchestrator returns the source
unchanged. On success it computes the final flags and calls `transformModule`:

```ts
const finalForceServerFunction = isServerEnvironment
  ? (forceServerFunction ?? hasServerDirective)
  : (explicitForceServerFunction ? forceServerFunction : undefined);
const finalForceClientComponent = isServerEnvironment
  ? (forceClientComponent ?? hasClientDirective)
  : (explicitForceClientComponent ? forceClientComponent : undefined);
```

In a server environment the flags reflect detected directives. In a non-server
environment they are `undefined` unless the caller explicitly forced them — so
auto-detected client/server modules reach `transformModule` with no force flags
and get directive-only treatment.

## `transformModule`: dispatch by flag × environment

`transformModule(source, moduleId, transformedModuleId, parseResult, options)`
(`TransformFunction`) is the router. It guards on `parseResult.type` and then:

**Non-server environment:**
1. `forceServerFunction` → `transformServerModule` (stub server actions even on
   the client; used for testing).
2. `forceClientComponent` → `transformClientModule` (stub client components;
   testing).
3. Otherwise → `transformNonServerEnvironment` (strip directives only).

**Server environment:**
- If neither force flag is set, return the source unchanged
  (`{ code: source, map: null }`) — nothing to register.
- `forceClientComponent` → `transformClientModule`.
- `forceServerFunction` → `transformServerModule`.
- A trailing `else if (isServerEnvironment)` falls back to
  `transformClientModule`.

It also threads `logger` / `verbose` onto the `loader` object so the downstream
helpers log consistently.

## `transformClientModule`: erase and stub

A client module in a server environment must not ship its implementation to the
server. `transformClientModule` therefore **discards the original source
entirely** and emits only:

1. `import { registerClientReference } from "<importClientPath>";`
2. one registration per export.

For each export of type `function`, `class`, or `null` (the last covers
re-transformed files where the type was lost):

```js
// default export
export default registerClientReference(
  function() { throw new Error("Attempted to call default() on the client"); },
  "<transformedModuleId>", "default");

// named export `Foo`
export const Foo = registerClientReference(
  function() { throw new Error("Attempted to call Foo() on the client"); },
  "<transformedModuleId>", "Foo");
```

If a client file has **no exports** (e.g. an entry point), it emits a single
throwing statement instead, so a stray server import of a client entry fails
loudly rather than silently:

```js
throw new Error('Client entry point was called from the server, but it is not available in server environment');
```

A source map is produced via `createSourceMap(finalCode, source,
transformedModuleId)` — note the original `source` is passed as
`sourcesContent`, so the directive-bearing original is preserved in the map even
though it was replaced in the output.

## `transformServerModule`: keep implementation, append registrations

A server module keeps its implementation and gains registrations. The function:

1. Obtains an AST via `loader.parse` (awaiting if it returns a Promise,
   unwrapping `{ ast }`), falling back to a direct `acorn.parse` with `ranges`
   and `locations` enabled. If the body is not iterable it throws.
2. Collects directive ranges to delete:
   - **File-level**: leading top-level `ExpressionStatement`s whose `directive`
     is `"use server"`, stopping at the first non-directive statement.
   - **Function-level**: `walkFunctionDirectives` recurses the whole tree; for
     every function/arrow whose first body statement is the literal
     `"use server"`, that statement's range is collected.
3. Removes all collected ranges with `removeDirectives`.
4. Builds `registerServerReference(<localName>, "<targetModuleId>",
   "<exportName>");` lines and appends them to the (directive-stripped) source,
   prepending the import. `targetModuleId` is `exp.originalModuleId ||
   transformedModuleId`, so re-exports register against their origin module.

The decision of *which* exports to register (`shouldRegister`) is:
function-level server directive on that export, **or** a file-level server
directive, **or** `!parseResult.directiveInfo.fileLevel` (no file-level
directive was detected — in which case it trusts the caller's decision to have
routed here at all, covering pre-compiled directives the AST may miss).

There is also a **client-component branch inside the server transform**: if
`parseResult.directiveInfo.fileLevel.type === "client"`, it additionally appends
`registerClientReference` stubs for every export (same throwing-stub shape as
`transformClientModule`) and adds the client import. In practice the orchestrator
routes client modules to `transformClientModule` directly; this branch is a
defensive fallback for callers that reach `transformServerModule` with a
client-directive parse result.

## `transformNonServerEnvironment`: strip directives, nothing else

On the client/SSR side, boundary modules need their directive prologue removed
(so the bundler does not choke on a stray `"use client"`/`"use server"`
expression) but must keep running their real implementation. This helper:

1. Parses to an AST (same `loader.parse`-then-acorn fallback as above).
2. Walks **only top-level** `ExpressionStatement` directives. Both
   `"use client"` and `"use server"` ranges are collected for removal —
   crucially, `"use server"` is *allowed* here because SSR is still server-side
   Node, so the actions run as ordinary async functions.
3. Calls `removeDirectives` and returns the result with a source map. No imports
   or registrations are added.

## Source surgery: `removeDirectives` / `removeRanges`

`removeDirectives(source, ranges)` sorts the ranges by start and delegates to
`removeRanges`, which splices each `[start, end)` slice out of the string
**from last to first** so earlier offsets stay valid as later text is removed.
`removeRanges` short-circuits on an empty list. Both are pure string functions
with no AST awareness — the caller is responsible for supplying correct offsets.

## `parse`: Rollup-shaped acorn wrapper

`parse(source)` returns `{ ast, code, map }` to mirror Rollup's `this.parse`.
It parses with `ecmaVersion: 'latest'`, `sourceType: 'module'`, `locations:
true`, and a permissive set (`allowAwaitOutsideFunction`,
`allowImportExportEverywhere`, `allowReturnOutsideFunction`, `allowReserved`).

Its `onComment` hook detects a trailing `# sourceMappingURL=` /
`@ sourceMappingURL=` comment and **strips it from `code`** (replacing it with
the right number of newlines to preserve line counts), returning the URL and its
range in `map`. So `code` is the source minus any embedded source-map comment,
and `map` is either that descriptor or `null`.

## `sourceMap`: line-granular maps + VLQ

`createSourceMap(code, originalSource, moduleId, rangesToRemove?)` builds a
version-3 `RawSourceMap`. It is **line-granular**, not token-accurate: it emits
one mapping per line, with special handling for lines that overlap a removed
directive range (it shifts by `lineShift` and accounts for the removed length in
the generated column). `sourcesContent` is set to the *original* source so
tooling can still show the pre-transform text. The module hand-rolls VLQ
encoding (`encodeVLQ` / `encodeBase64Digit`) rather than pulling in a dependency.

Companion helpers (not exported from `index.ts`): `stripSourceMap`,
`addSourceMap`, and `parseSourceMapUrl` for moving a base64 inline map in and out
of a source string.

## One-shot wrappers

`transformModuleIfNeeded(source, moduleId, options)` and
`transformWithAcornLoose(source, moduleId, options)` both construct a
`createTransformer` and immediately run it once. They exist so a caller that just
wants "transform this one module" need not manage the factory. The only
difference: `transformModuleIfNeeded` honours `options.loader.parse` as the
`parseFn` when it is a function (falling back to `parse`), while
`transformWithAcornLoose` always uses `parse`. Despite its name,
`transformWithAcornLoose` uses the strict acorn `parse`, not `acorn-loose`.

## Types worth knowing

- `TransformResult = { code: string; map: RawSourceMap | null }` — the universal
  return shape.
- `TransformOptions` — the per-call knobs: `forceServerFunction`,
  `forceClientComponent`, `isServerEnvironment`, `loader`, `directiveWarnings`,
  `verbose`, `panicThreshold`, `mode`, `logger`, `moduleBase`,
  `tolerateLeadingCode`. (`removeDirectives` / `addDirectives` index arrays are
  declared but reserved.)
- `LoaderConfig` — the full transport contract; the public `loader` option is a
  partial override merged over `DEFAULT_LOADER_CONFIG`.
- `ParseFn` — `(source) => Program | { ast; code?; map?; exports? } | Promise<…>`;
  this is why every helper unwraps `{ ast }` and awaits a possible Promise.
- `TransformerFactory` — the signature of `createTransformer`, including the
  testing-only `forceServerFunction` / `forceClientComponent` / `ssr` /
  `originalModuleId` inputs.

## See also

- [`directive-engine.md`](./directive-engine.md) / `src/directives/` —
  `analyzeModule`, `findDirectiveMatches`, `detectClientModule`, and
  `ParseResult`, which the transformer consumes.
- [`architecture.md`](./architecture.md) — how the transformer fits the rest of
  the package, including the Node ESM loader factory.
- `src/runtime/env.ts` — `isReactServerCondition`, `getNodeEnv`.
