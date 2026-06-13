# Directive engine (internals)

> Audience: contributors to `react-server-loader`. For the consumer-facing API
> (`detectClientModule`, `sourceHasTopLevelClientDirective`, `analyzeModule`)
> see [`../api-reference.md`](../api-reference.md). Nothing here is part of the public
> surface — the symbols below live under `src/directives/*` and are not exported
> from the package's public entry points.

The directive engine is the smallest reusable piece of the package: a pure set
of functions over a module's source string and its AST that decides whether the
module declares a React Server Components boundary (`"use client"` /
`"use server"`), where the directive sits, and whether its placement is legal.
It produces no side effects beyond optional `logger` calls — the transformer
consumes its output and does the actual rewriting.

All source lives in `src/directives/`. The barrel (`src/directives/index.ts`)
re-exports everything, but only a subset is surfaced through the package's
public `react-server-loader/directives` entry.

## Data flow

```
source ─┬─► findDirectiveMatches(source) ──► DirectiveMatches (regex hits)
        │
        └─► parse(source) ──► Program (AST)
                                │
        DirectiveMatches + AST ─┴─► analyzeDirectives(ast, source, options) ──► DirectiveInfo
                                                                                   ├─ fileLevel
                                                                                   ├─ functionLevel[]
                                                                                   └─ warnings[]
```

`analyzeModule` (consumer entry) wires the two halves together and bolts on
export collection; `detectClientModule` is a thin yes/no classifier layered on
top of the same `analyzeDirectives`.

## `findDirectiveMatches(source)` — the regex pass

`src/directives/findDirectiveMatches.ts`. Source-string scan, no AST. Two
global regexes find every `"use server"`/`'use server'` and
`"use client"`/`'use client'` occurrence:

```ts
const regex = /"use server"|'use server'/g; // and the matching "use client" pair
```

Each hit becomes a `DirectiveMatch` with a `range: [start, end]` (byte offsets
into the source) and a `type` of `"server"` or `"client"`. All hits are merged
and sorted ascending by `range[0]`:

```ts
const allMatches = [...serverMatches, ...clientMatches]
  .sort((a, b) => a.range[0] - b.range[0]);
```

The return type is `DirectiveMatches = { matches: DirectiveMatch[]; warnings: DirectiveWarning[] }`.
The `warnings` array is always returned empty here — the regex pass makes no
judgements. Every match is tentatively "function-level"; `analyzeDirectives`
decides which one is actually file-level. Because this is a raw string scan, it
will also match occurrences inside strings or comments; the AST pass in
`analyzeDirectives` is what disambiguates real directive prologues from
coincidental text.

## `analyzeDirectives(ast, source, optionsOrMatches?, logger?)`

`src/directives/analyzeDirectives.ts`. The core. Two overloads share one
implementation:

```ts
function analyzeDirectives(ast, source, matches?: DirectiveMatches, logger?): DirectiveInfo;
function analyzeDirectives(ast, source, options?: DirectiveOptions, logger?): DirectiveInfo;
```

The third argument is overloaded: pass a `DirectiveMatches` (the
`findDirectiveMatches` output) to reuse a precomputed scan, or pass
`DirectiveOptions` to let `analyzeDirectives` call `findDirectiveMatches(source)`
itself. The implementation distinguishes them by `"matches" in optionsOrMatches`
— a `DirectiveMatches` has a `matches` key, a `DirectiveOptions` does not. When
options are supplied, the engine reads `verbose`, `logger`, `loader.getDirectiveType`,
and `tolerateLeadingCode` off them (each guarded by an `in` check, so a
`DirectiveMatches` value safely yields the defaults).

Return shape:

```ts
type DirectiveInfo = {
  fileLevel: DirectiveMatch | null;
  functionLevel: FunctionLevelDirectiveMatch[];
  warnings: DirectiveWarning[];
};
```

### File-level pass

The engine walks `ast.body` (top-level statements only) to find the file-level
directive. Key bits of bookkeeping:

- `firstDirective` — the first React directive (`use client` / `use server`)
  found at the top level. It becomes `directiveInfo.fileLevel`.
- `foundNonDirective` — set once we see real code before `firstDirective`.
- `lastProloguePos` — the end offset of the last consecutive *prologue* directive
  walked past. Non-React string prologues like `"use strict"` are tolerated above
  a `"use client"`/`"use server"`; this cursor is the start of the
  "is there real code before this node?" range, so a benign prologue does not get
  classified as code-before-directive.

A statement is recognised as a React directive two ways, mirroring how acorn
reports prologues. First, acorn sets `node.directive` on a leading
string-literal `ExpressionStatement`; if that string is `"use server"` or
`"use client"` it is taken as the directive. Otherwise the literal expression is
inspected directly (`node.expression.type === "Literal"` with a `"use server"`/
`"use client"` value). The filter on the literal *text* is deliberate: real
compiled libraries (e.g. `@chakra-ui/react`, `@ark-ui/react`) ship
`"use strict"; "use client"; …`, and accepting any prologue into the file-level
slot would make the real `"use client"` arrive as a *second* directive and trip
the "cannot have both" warning. Filtering on the literal value lets a
`"use strict"` prologue coexist with the React directive cleanly.

`isDirectivePrologue` is a broader test (true for any acorn `node.directive`
string, plus the React literals). It governs which non-matching statements are
*skipped* rather than counted as code: a `"use strict"` is a prologue, so it
doesn't push a later `"use client"` out of position; a real expression statement
is not, so it sets `foundNonDirective`.

The directive's `type` is resolved through `loader.getDirectiveType(directive)`
when the host supplied that override (off `optionsOrMatches.loader`), falling
back to the literal mapping (`"use server"` → `"server"`, else `"client"`).

When a *second* top-level React directive is encountered after `firstDirective`,
the engine pushes a warning:

> Cannot have both 'use client' and 'use server' directives in the same file

(with `range: [0, 0]`, `type: "server"`).

For every non-directive top-level node seen *before* `firstDirective`,
`foundNonDirective` is set — imports/exports and any other statement count as
real code.

Comments and benign prologues are not code, though. `"use strict"`-style string
prologues are walked past via `lastProloguePos`, so they don't push a later
`"use client"` out of position; and the final placement guard strips `/* … */`
and `// …` comments out of the gap between `lastProloguePos` and the directive
before judging it misplaced. So a JSDoc or banner comment above the directive —
common in compiled library output (tsup/rollup banners) — is treated as trivia,
not as "other code", and does not trip the placement warning.

After the loop, if `firstDirective` exists it is assigned to
`directiveInfo.fileLevel`, and that comment-stripping guard runs over the gap
before the directive. The placement warning fires only when
`foundNonDirective && !tolerateLeadingCode`:

> File-level directives must be at the top of the file, before any other code

(`range` = the directive's range, `type` = the directive's type).

### `tolerateLeadingCode` policy hook

`analyzeDirectives` itself ships **no** bundler-specific assumptions. A host may
legitimately prepend code above a file-level directive — a bundler injecting
imports, an HMR runtime — which would otherwise trip the placement warning. The
host owns that policy via the option:

```ts
tolerateLeadingCode?: (source: string) => boolean;
```

It is evaluated once, eagerly, against the whole source:

```ts
const tolerateLeadingCode =
  hasOptions && "tolerateLeadingCode" in optionsOrMatches &&
  typeof optionsOrMatches.tolerateLeadingCode === "function"
    ? optionsOrMatches.tolerateLeadingCode(source)
    : false;
```

Default is strict (`false`). When it returns `true`, the
"must be at the top of the file" warning is suppressed — but `fileLevel` is
still set and `foundNonDirective` is still computed; only the warning is gated.
(A Vite host, for instance, passes a predicate that looks for injected markers
like `__vitePreload`.)

### Function-level pass

After resolving the file-level directive, the engine processes the remaining
regex matches as candidate function-level directives. First it filters out the
match whose range exactly equals `fileLevel.range` (so the file-level directive
isn't double-counted):

```ts
const functionLevelMatches = directiveMatches.matches.filter(
  (match) => !(fileLevel && match.range[0] === fileLevel.range[0]
                         && match.range[1] === fileLevel.range[1])
);
```

It then traverses the AST with a hand-rolled walker, `traverseWithContext` /
`traverseChildren`, threading a `{ inFunction, inClass }` context. The walker
iterates every own object/array property of each node (skipping `parent`,
`start`, `end`, `loc`, `range`) — there is no acorn-walk dependency. Context
transitions:

- a function node → recurse with `inFunction: true`
- a `ClassDeclaration` / `ClassExpression` / `MethodDefinition` → recurse with
  `inClass: true`
- anything else → recurse with the same context.

For each function node, `getFunctionBody(node)` returns its `BlockStatement`
body (or `null`). For each candidate match the engine checks
`isDirectiveAtStart(node, getDirectiveValue(match.type))` and then confirms the
match's range overlaps the actual first-statement directive node via
`matchOverlapsDirective(match.range, directiveStart, directiveEnd)`. This pairing
of regex-range to AST-position is what prevents a `"use server"` string appearing
elsewhere in the function from being mistaken for the prologue.

On a confirmed function-level directive, context drives validation:

| Context (`inFunction` / `inClass`) | Outcome |
|---|---|
| nested in another function | warning: *Function … with '…' directive cannot be nested inside another function. Directives are only allowed in top-level functions.*; function skipped |
| inside a class (method) | warning: *Class method … with '…' directive is not supported. Directives are only allowed in top-level functions.*; function skipped |
| top-level, `type === "server"` | queued into `functionNodes` for the second pass |
| top-level, `type === "client"` | warning: *Function-level 'use client' isn't allowed* |

Function name for the messages comes from `getFunctionName(node)` (falls back to
`"anonymous"`).

A **second pass** then walks the queued `functionNodes`. Each is keyed by
`` `${name}-${exportName || ""}-${match.range[0]}` `` and de-duplicated through a
`processedFunctions` Set, then handed to `processFunctionNode`. `name` comes from
`getFunctionName`, `exportName` from `getExportedName`.

### `processFunctionNode`

`src/directives/processFunctionNode.ts`. Resolves the body for the supported
node shapes (`MethodDefinition.value`, object `Property.value`, or a plain
function's `BlockStatement` body), re-confirms `isDirectiveAtStart`, then:

- If a `fileLevel` directive already exists, it pushes
  *'use …' is already defined at the top of the file, this directive should be removed.*
  and returns (a function-level directive is redundant under a file directive).
- For `type === "server"`: the function **must be async** (`isAsyncFunction`).
  If async, it's recorded into `directiveInfo.functionLevel` as
  `{ type: "server", name, exportName: exportName ?? "default", range }`.
  If not async, it warns:
  *`<FunctionType>` `'<name>'` with 'use server' directive must be declared as async*
  (function-type label from `getFunctionTypeDescription`).
- For `type === "client"`: warns *'use client' directive is only allowed at the
  top of a file*.

Note `functionLevel` only ever holds **server** directives — the type is
`FunctionLevelDirectiveMatch` whose `type` is the literal `"server"`.

### Cross-directive consistency warnings

Finally, if both a `fileLevel` directive and one or more `functionLevel` entries
exist, the engine emits a warning per function-level entry:

- file type ≠ function type → *Cannot have both 'use `<file>`' and 'use `<func>`'
  directives in the same file*
- function type isn't `"server"` → *Function-level directives should be
  'use server', but got 'use `<type>`'*
- otherwise (redundant with a file-level `use server`) → *'use server' is already
  defined at the top of the file, this directive should be removed.*

Because `processFunctionNode` already returns early when a file-level directive
is present, in practice `functionLevel` is empty whenever `fileLevel` is set, so
this block is largely defensive.

## The warnings array

`directiveInfo.warnings` is the engine's single diagnostic channel. Every
`DirectiveWarning` is `{ message: string; range: DirectiveRange; type: DirectiveType }`.
The engine never throws on a bad directive — it records a warning and keeps a
best-effort classification (`fileLevel` is still set even when its placement is
flagged). Downstream code decides whether a warning is fatal. `detectClientModule`,
for instance, treats the "must be at the top of the file" warning as
disqualifying:

```ts
const misplaced = directiveInfo.warnings.some((w) =>
  w.message.includes("must be at the top of the file"));
return !misplaced;
```

The transformer applies its own `panicThreshold` policy to the same array.

## AST type-guards and helpers

`src/directives/typeGuards.ts` is a flat list of `node is T` predicates over
acorn `Node`s — `isProgram`, `isFunctionNode` (FunctionDeclaration /
FunctionExpression / ArrowFunctionExpression), `isMethodDefinition`,
`isProperty`, `isVariableDeclarator`, `isExportNamedDeclaration`,
`isClassBody`, `isStringLiteral`, `isDirective`, `canHaveDirective`,
`isAsyncFunction`, `isFunctionLikeWithBlock`, `isNodeWithParent`, and friends.
They exist so the rest of the engine narrows acorn unions without scattering raw
`node.type === "…"` comparisons. `types.ts` augments acorn's `Node` with an
optional `parent`, and the parent-walking helpers (`getFunctionName`,
`getQualifiedName`, `getExportedName`) rely on that field being populated by the
parser.

Helper roles:

| Helper | File | Role |
|---|---|---|
| `getFunctionBody` | `getFunctionBody.ts` | Returns the `BlockStatement` body for a function/method/object-method/arrow-in-declarator, else `null`. |
| `isDirectiveAtStart` | `utils.ts` | True when the function body's first statement is a string-literal `ExpressionStatement` equal to the directive value. |
| `getDirectiveValue` | `utils.ts` | `"server"` → `"use server"`, `"client"` → `"use client"`. |
| `matchOverlapsDirective` | `utils.ts` | Range-overlap test between a regex match and the AST directive node. |
| `getFunctionName` | `getFunctionName.ts` | Local name: declaration id, or parent variable/method/property key, else `getQualifiedName`, else `"anonymous"`. |
| `getQualifiedName` | `getQualifiedName.ts` | Dotted path by walking `parent` (e.g. `Class.method`, `obj.fn`), else `"anonymous"`. |
| `getExportedName` | `getExportedName.ts` | Export-facing name (`default`, `Class.prototype.method`, nested `obj.prop` paths). |

## Exports collection (adjacent, not part of directive analysis)

`getExports` / `collectExports` / `addLocalExportedNames` live in the same
directory but are an orthogonal concern: they map a module's exported names to
`ExportInfo` records so `analyzeModule` can attach `exports` alongside
`directiveInfo`. `collectExports` walks `program.body`, handling default,
named, and re-export forms; `ExportAllDeclaration` (`export *`) is intentionally
ignored, matching React's loader behaviour (the re-exported module must opt into
its own directive). `addLocalExportedNames` recurses through destructuring
patterns to enumerate the bound names. These do not influence directive
classification — they ride alongside it in the `ParseResult`.

## `analyzeModule` glue

`src/directives/analyzeModule.ts`. The async consumer-facing entry:

1. Parse with `loader.parse(source)` if supplied (a bundler can pass its own
   parser so the AST matches the rest of the build), else the package's built-in
   `parse`. Awaits the result if it's a Promise, and normalises a bare AST return
   into `{ ast }`.
2. Collect exports — uses `result.exports` if the parser already produced them,
   else `getExports(ast)`.
3. Run `analyzeDirectives(result.ast, source, options)`.
4. Return a `ParseResult` of `type: "success"` carrying `code`, `map`, `ast`,
   `exports`, and `directiveInfo`.

`verbose` gates `logger.info` traces of the discovered exports and warnings.

## Related

- [`../api-reference.md`](../api-reference.md) — consumer API for directive detection.
- [`./architecture.md`](./architecture.md) — how the directive engine fits the
  rest of the pipeline (parse → analyze → transform).
