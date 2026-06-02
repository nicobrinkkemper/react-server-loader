# Versioning

`react-server-loader` (rsl) bundles a *transport* —
`react-server-dom-esm`, the RSC wire format that the React team doesn't
publish to npm. That transport reaches into React's private internals at
runtime, so rsl can't float free of the React it was built against. Its
version scheme reflects that: **the rsl version is the React version it
vendors.**

This page is about picking and installing the right combination. For *why*
the transport binds so tightly to a specific React build — and how the
version/peer fields get stamped — see
[internals/vendoring-and-publishing](./internals/vendoring-and-publishing.md#why-version--transport-version).

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
dependencies** and pins them to the build it was vendored from. A mismatched
install surfaces as a peer-dependency warning at install time, before it can
fail at runtime.

## Two trains

React ships on two release channels, and rsl mirrors them one-to-one. Pick
the train that matches the React you build against.

| Train | dist-tag | rsl version | `react` / `react-dom` peer |
| --- | --- | --- | --- |
| **stable** | `latest` | `<ReactVersion>` — e.g. `19.2.7` | `^<ReactVersion>` — e.g. `^19.2.7` |
| **experimental** | `experimental` | `0.0.0-experimental-<sha>-<date>` | that **exact** string |

You need a React **19+** build with React Server Components support either
way.

### Stable (the `latest` tag)

```bash
npm install react-server-loader react react-dom
```

The stable rsl version *is* a React version (`19.2.7` vendors React
`19.2.7`), and its peer range is `^<ReactVersion>`. The caret means any
React 19.x at or above that minor satisfies the install — patch and minor
React updates don't force an rsl bump on you.

### Experimental (the `experimental` tag)

```bash
npm install react-server-loader@experimental react@experimental react-dom@experimental
```

The experimental train carries the newest RSC features, and it's stricter.
Its version is the literal React experimental build string
(`0.0.0-experimental-<sha>-<date>`), and its peer **pins that exact
string** — no caret, no range. The matching React has to be the same commit
rsl was vendored from.

That matters because the `react@experimental` dist-tag moves daily. Grabbing
`react-server-loader@experimental` and `react@experimental` on different days
can land you on two different commits that won't run together. When in doubt,
read the exact build off rsl's peer and pin React to it:

```bash
npm view react-server-loader@experimental peerDependencies
npm install react@<that-exact-version> react-dom@<that-exact-version>
```

Or install all three from their `@experimental` dist-tags in one shot (as
above) so they resolve to the same day's build.

## Picking a version

- Building against **stable React 19**? Use the `latest` train. A normal
  `npm install react-server-loader react react-dom` lines everything up.
- Need **bleeding-edge RSC features**? Use the `experimental` train, and
  pin `react` / `react-dom` to the exact build rsl names in its peer.
- Either way, if the peer-dependency checker warns about a `react` /
  `react-dom` skew, fix it before running — that warning is the early
  signal of the runtime mismatch described above.
