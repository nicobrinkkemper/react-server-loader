# Troubleshooting

Symptom → cause → fix for the failures you're most likely to hit wiring
`react-server-loader` into a server. Most of them trace back to one root
cause: the transport (`react-server-dom-esm`, vendored into rsl) is
hard-bound to one React build's internals, so the `react` / `react-dom`
you install must match the React that rsl was built against.

See [Versioning](./versioning.md) for why the versions line up the
way they do.

---

## "A React Element from an older version of React was rendered"

**Symptom.** Rendering throws:

```
A React Element from an older version of React was rendered. This is not
supported. It can happen if:
- Multiple copies of the "react" package is used.
- A library pre-bundled an old copy of "react" or "react/jsx-runtime".
- A compiler tries to "inline" JSX instead of using the runtime.
```

**Cause.** The element being rendered came from a *different* copy of
React than the one the transport is reading. The vendored transport binds
to a single React build's internals; if `react` resolves to more than one
version in your graph — or to a version other than the one rsl vendors —
the element shape no longer matches and the render bails.

This is almost always **react / react-dom version skew**: rsl's version
equals the React it vendors, and your installed `react` / `react-dom`
drifted off it (a transitive dependency pinned an older React, a stale
`node_modules`, or a manual bump).

**Fix.** Install the React that matches rsl's version.

- **Stable train:** rsl version `<ReactVersion>` (e.g. `19.2.7`) wants
  `react` / `react-dom` at `^<ReactVersion>`:

  ```bash
  npm install react@^19.2.7 react-dom@^19.2.7
  ```

- **Experimental train:** the peer pins the *exact*
  `0.0.0-experimental-<sha>-<date>` rsl was vendored from. Read it off the
  package and install that build (see
  [Experimental dist-tag drift](#experimental-dist-tag-drift) below).

Then confirm only one copy of React is resolved:

```bash
npm ls react react-dom
```

A single, deduped entry at the expected version means no skew. If `npm ls`
shows two `react` versions, a dependency is dragging in its own — dedupe it
(`npm dedupe`) or align the offending dependency's React range.

---

## ReactSharedInternals / "react" package not configured correctly

**Symptom.** Starting the server throws:

```
The "react" package in this environment is not configured correctly. The
"react-server" condition must be enabled in any environment that runs
React Server Components.
```

**Cause.** The transport looks up React's server-side internals
(`React.__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE`)
and finds them missing. That field only exists when `react` is resolved
through its **server** exports — i.e. when the process runs under the
`react-server` resolution condition. Without the condition, `react`
resolves to its client build, the server internals aren't there, and the
transport throws on startup.

**Fix.** Run the rendering process under `--conditions react-server`:

```bash
node --import ./register.mjs --conditions=react-server server.js
```

You can also enable it through `NODE_OPTIONS`:

```bash
NODE_OPTIONS="--conditions=react-server" node server.js
```

This is the same condition that makes `react` and `react-server-dom-esm`
resolve to their server-side exports. rsl exposes a helper that reports
whether the current process has it enabled — `isReactServerCondition()` is
internal, but the underlying check is simply whether `react-server` appears
in `process.execArgv` or `NODE_OPTIONS`, so the two flags above are
interchangeable.

> The `react-server-loader/server` and `/static` subpaths require this
> condition. `react-server-loader/client` (and `/client.browser`) do not —
> the client transport runs in the regular (non-server) environment.

---

## Peer dependency install errors

**Symptom.** `npm install` fails or warns with an `ERESOLVE` /
unmet-peer-dependency error naming `react`, `react-dom`, or
`react-server-loader`.

**Cause.** rsl declares `react` / `react-dom` as peers and the version you
have (or have pinned elsewhere) doesn't satisfy rsl's peer range. The
range is deliberately tight because the transport can't tolerate a
mismatched React (see the two errors above).

**Fix.** Install React and rsl from the **same train** so the peer ranges
agree:

```bash
# stable
npm install react-server-loader react react-dom

# experimental
npm install react-server-loader@experimental react@experimental react-dom@experimental
```

If you're pinning React yourself, match rsl's peer exactly. Check what rsl
expects:

```bash
npm view react-server-loader peerDependencies
# or, for the experimental train:
npm view react-server-loader@experimental peerDependencies
```

Then install `react` / `react-dom` at a version that satisfies it. Don't
reach for `--force` or `--legacy-peer-deps` to paper over the warning —
the peer range is enforcing the version match the transport needs at
runtime, so bypassing it just defers the
["older version of React"](#a-react-element-from-an-older-version-of-react-was-rendered)
crash to render time.

---

## Experimental dist-tag drift

**Symptom.** You installed `react-server-loader@experimental` and
`react@experimental` (or `react-dom@experimental`) in the same `npm
install`, yet you still hit a peer-dependency error, or the
["older version of React"](#a-react-element-from-an-older-version-of-react-was-rendered)
crash at render time.

**Cause.** The `react@experimental` dist-tag **moves daily** — it points
at React's latest experimental commit. rsl's experimental peer pins the
*exact* `0.0.0-experimental-<sha>-<date>` it was vendored from. Those two
pointers only line up when both packages were built from the same React
commit. Install on a day when `react@experimental` has moved ahead of the
commit rsl was built from, and you get a different experimental React than
the transport expects — different per-commit internals, hence the
mismatch.

**Fix.** Don't rely on the `@experimental` tag lining up by luck — read
the exact peer off rsl and pin React to it:

```bash
npm view react-server-loader@experimental peerDependencies
# -> react / react-dom: "0.0.0-experimental-<sha>-<date>"

npm install react@<that-exact-version> react-dom@<that-exact-version>
```

When in doubt, **pin the exact version** rather than the `@experimental`
tag. The experimental train is intentionally strict: a wider range would
let you pair the vendored transport with a different experimental React and
crash on the internals mismatch.

> Experimental versions sort below `1.0.0`, so they never satisfy a `^19`
> range — the experimental train stays opt-in and won't accidentally
> resolve from a stable install.

---

## Still stuck?

Most failures here reduce to *which React is resolved, and was the
`react-server` condition set*. A quick triage:

```bash
npm ls react react-dom                          # exactly one of each?
npm view react-server-loader peerDependencies   # which React does rsl's transport need?
node -p "process.execArgv"                      # does it include --conditions=react-server?
```

If those three line up and you still see a mismatch, see
[Versioning](./versioning.md) for how the trains are stamped, or
the [README](../README.md) for install and wiring details.
