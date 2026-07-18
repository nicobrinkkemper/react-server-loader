# Versioning

`react-server-loader` (rsl) bundles two *transports*, built from the same
React checkout at the same ref: `react-server-dom-esm` (which the React team
doesn't publish to npm) and `react-server-dom-webpack` (which it does — but
vendoring both from one build keeps them, and the React peer, pinned as a set
under one rsl version). The transports reach into React's private internals at
runtime, so rsl can't float free of the React it was built against.

Two fields encode that, and they encode **different** things:

- the **peer** (`react` / `react-dom`) names the exact React build the
  transport was vendored from — the binding that must match at runtime;
- the **version** is rsl's *own*. Its major.minor tracks React's minor, but
  the **patch is rsl's revision** — exactly like `@types/react@19.2.x` tracks
  React 19.2 while owning the `.x`. That's what lets rsl ship a fix to its own
  code (loader, transformer, shims) without waiting for a new React release.

This page is about picking and installing the right combination. For *why* the
transport binds so tightly to a specific React build — and why the version is
rsl's own — see
[internals/vendoring-and-publishing](./internals/vendoring-and-publishing.md#versioning).

## The rule: rsl, react, and react-dom move together

The vendored transport calls into `ReactSharedInternals` — undocumented
fields on the `react` and `react-dom` packages that change between builds.
Install an rsl whose transport expects a different React than the one
actually loaded and you get a runtime error, not a graceful fallback (React
itself throws on *"a React Element from an older version of React"*). There
is no shimming around it.

So the three packages are installed as a set:

```bash
npm install react-server-loader react react-dom
```

To keep them honest, rsl declares `react` and `react-dom` as **peer
dependencies** pinned to the build it was vendored from. A mismatched install
surfaces as a peer-dependency warning at install time, before it can fail at
runtime — so trust the peer, not the version number, to tell you which React
to install.

## Two trains

React ships on two release channels, and rsl tracks them. Pick the train that
matches the React you build against.

| Train | dist-tag | rsl version | `react` / `react-dom` peer |
| --- | --- | --- | --- |
| **stable** | `latest` | `19.<minor>.<rsl-patch>` — e.g. `19.2.8` | `^<vendored React>` — e.g. `^19.2.7` |
| **experimental** | `experimental` | `0.0.0-experimental-<sha>-<date>[.<rsl-revision>]` | that **exact** string, **without** the revision |

You need a React **19+** build with React Server Components support either
way.

### Stable (the `latest` tag)

```bash
npm install react-server-loader react react-dom
```

The stable version's **major.minor** tracks React's minor (`19.2.x` → React
19.2), but the **patch is rsl's own revision** — `react-server-loader@19.2.8`
does not mean React 19.2.8; it means rsl revision 8 on the React 19.2 line.
Which React it actually vendored is in the **peer** (`^19.2.7`), and a plain
`npm install react-server-loader react react-dom` resolves `react` to a
matching build. The caret means any React 19.x at or above the vendored build
satisfies the install — React patch/minor updates don't force an rsl bump.

(So the version is monotonic but doesn't encode React's exact patch; the peer
does. This is the trade for being able to ship rsl-only fixes between React
releases — see the internals doc.)

### Experimental (the `experimental` tag)

```bash
npm install react-server-loader@experimental react@experimental react-dom@experimental
```

The experimental train carries the newest RSC features, and it's stricter. Its
peer **pins the exact React build string** — no caret, no range. The matching
React has to be the same commit rsl was vendored from.

**rsl owns its revision here too.** The version is the React build string with an
optional `.N` on the end:

| | |
| --- | --- |
| version | `0.0.0-experimental-c0c39a6b-20260709.1` ← `.1` is *rsl revision 1* |
| peer | `0.0.0-experimental-c0c39a6b-20260709` ← the React build, no revision |

This is the same `@types`-style split stable uses, and it exists for the same
reason: without it, an **rsl-only fix** (a loader or transformer bug, no React
change) has *no version to ship under* on this train, and is stuck until React
cuts a new nightly. That is not hypothetical — it cost us a permanently
deprecated release. React nightlies can be days apart, and an rsl version can
never be unpublished (vprs depends on it in the registry, which disqualifies it),
so a bad experimental build with nowhere to ship its own fix is **permanent**.

`.1` sorts *above* the bare build string and *below* any stable version, so the
`experimental` dist-tag moves forward cleanly and plain `npm install` is
untouched. The peer never carries the revision — `react@<build>.1` does not
exist, and naming it would 404 both the install and the release gate.

Cut one with `--revision`:

```bash
./scripts/release.sh --channel experimental --react-ref <the React sha> --revision 1
```

### Pinning React on this train

The exact peer pin matters because the `react@experimental` dist-tag moves daily.
Grabbing `react-server-loader@experimental` and `react@experimental` on different
days can land you on two different commits that won't run together. When in
doubt, read the exact build off rsl's peer and pin React to it:

```bash
npm view react-server-loader@experimental peerDependencies
npm install react@<that-exact-version> react-dom@<that-exact-version>
```

Or install all three from their `@experimental` dist-tags in one shot (as
above) so they resolve to the same day's build.

## Picking a version

- Building against **stable React 19**? Use the `latest` train. A normal
  `npm install react-server-loader react react-dom` lines everything up — let
  the peer pick the React, ignore the rsl patch number.
- Need **bleeding-edge RSC features**? Use the `experimental` train, and
  pin `react` / `react-dom` to the exact build rsl names in its peer.
- Either way, if the peer-dependency checker warns about a `react` /
  `react-dom` skew, fix it before running — that warning is the early
  signal of the runtime mismatch described above.
