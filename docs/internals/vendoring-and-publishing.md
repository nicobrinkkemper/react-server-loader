# Vendoring the transport & cutting releases

> Internals. This documents how `react-server-dom-esm` gets into the package
> and how a release is built and published. For the consumer-facing view, see
> the README's *Versioning* and *Building a release* sections.

`react-server-loader` ships a *copy* of `react-server-dom-esm` — the RSC
transport — because the React team does not publish it to npm. The rest of the
package (loader, directives, transformer) is ordinary TypeScript built from
`src/`. The transport, by contrast, has to be produced by React's own build
pipeline and copied in. That is what `scripts/build-rsl.sh` does, and why a
release is "rebuild against a React ref, then pack."

Only `react-server-dom-esm` is vendored. `react` and `react-dom` are **not** —
they always come from the consumer's own install (the matching peer-dep range).

## Versioning

The transport is hard-bound to one React build's internals. At runtime it reads
React's `ReactSharedInternals`; pair it with a different copy of React and it
throws a *"React Element from an older version of React"* style error. So
**which React** must be unambiguous — but that job belongs to the **peer**, not
the version.

- The **peer** (`react`/`react-dom`) names the React build the transport was
  vendored from. It's the binding that must match; a skewed install warns at
  install time, before it can fail at runtime.
- The **version** is rsl's *own*. Stable follows the **`@types` model**:
  major.minor tracks React's minor, the **patch is rsl's revision** (just as
  `@types/react@19.2.x` tracks React 19.2 while owning the `.x`). Experimental
  is a per-build snapshot keyed to the React commit.

| channel | rsl version | `react`/`react-dom` peer | npm dist-tag |
| --- | --- | --- | --- |
| **stable** | `19.<minor>.<rsl-patch>` (e.g. `19.2.8`) | `^<vendored React>` (e.g. `^19.2.7`) | `latest` |
| **experimental** | `0.0.0-experimental-<sha>-<date>` | that **exact** string | `experimental` |

### Why stable owns its patch (and doesn't just equal the React version)

The first stable cut, `19.2.7`, *did* equal the React it vendored — convenient,
but a trap. npm versions are immutable and nothing sorts between `19.2.7` and
React's eventual `19.2.8`, so once `19.2.7` was published, an **rsl-only fix**
(a bug in the loader/transformer/shims, with no React change) had **no version
to ship under** — it was stuck until React itself released. That bit us
immediately: the prerender + ESM-server shim fixes needed for a consumer had
nowhere to go.

The `@types` model fixes it: the patch is rsl's, so `19.2.8` is *rsl revision 8*
on the React 19.2 line — it still vendors React `19.2.7` (see the peer). There's
no npm collision with a future `react@19.2.8` because they're different
packages, exactly as `@types/react@19.2.x` coexists with `react@19.2.y`. React
compat is enforced by the peer, not the version string, so the
`ReactSharedInternals` binding stays sound. (This mirrors how `@types/*` vendor
a specific upstream while shipping their own revisions.)

### How `build-rsl.sh` stamps it

`build-rsl.sh` writes the **version** and `react`/`react-dom` **peer** onto
rsl's own `package.json`, and mirrors the version onto the vendored transport's
`package.json` so the publish guard can assert they agree.

- **stable** — keeps rsl's own version (maintainer-managed in `package.json`;
  bump the patch per release), and sets peer `^<vendored React>`. React keeps
  the RSC ABI stable within a major, so the caret floors at the vendored build
  and is safe up to the next major — same range `react-server-dom-webpack`
  ships. The script warns if `package.json`'s major.minor has drifted from the
  vendored React (set it to `<major>.<minor>.0` when moving to a new React
  minor).
- **experimental** — synthesizes `0.0.0-experimental-<sha>-<date>` and pins the
  peer to that exact string. Internals change per commit, so the peer is exact;
  a wider range would let a consumer pair this transport with a *different*
  experimental React and crash on the `ReactSharedInternals` mismatch. `<sha>`
  is the React commit's first 8 chars (`git rev-parse HEAD`); `<date>` is the
  committer date `YYYYMMDD` in the commit's own timezone (matching
  facebook/react's `build-all-release-channels.js`, **not** UTC). Patch by
  republishing with a trailing `.N`, which sorts above the original.

The two dist-tags never move each other's pointer, so both trains coexist.

## `scripts/build-rsl.sh`

```
./scripts/build-rsl.sh [--channel <stable|experimental>] \
                       [--react-ref <ref>] \
                       [--react-dir <path>]
```

Defaults: `--channel experimental`. `--react-ref` defaults to `main` for
experimental and `v19.0.0` for stable. `--react-dir` defaults to a sibling
`../react` checkout if one exists, otherwise a shallow clone in `.tmp/react/`.

What it does, in order:

1. **Resolve / fetch React.** If `--react-dir` doesn't exist, shallow-clone
   `facebook/react` at the requested ref (falling back to a depth-1 clone of
   the default branch if the branch clone fails). If it does exist, reuse it
   and, for any ref other than `main`, attempt `git fetch` + `git checkout` of
   that ref (tolerating failure — it builds against current HEAD and warns).

2. **Install React's build deps** via `yarn install --frozen-lockfile`. React's
   repo uses yarn workspaces; `yarn` is required (the script errors out if it's
   missing).

3. **Run React's rollup build** for just the transport:
   `RELEASE_CHANNEL="$CHANNEL" node scripts/rollup/build.js react-server-dom-esm`
   (~2 min). React's build pulls transitive packages into the graph even when
   one package is requested, and a downstream `eslint-plugin-react-hooks`
   TypeScript step can fail on a clean checkout — so the script disables
   `pipefail` around this step and tolerates a non-zero exit, then **validates
   the artifacts actually landed** instead of trusting the exit code.

4. **Validate + vendor.** It requires both the rollup output
   (`build/node_modules/react-server-dom-esm`) and the source
   `packages/react-server-dom-esm/package.json` to exist, then clears and
   recreates `vendor/react-server-dom-esm/`, copies the rollup output into it
   (the `cjs/` + `esm/` artifacts), and copies React's source `package.json`
   over the top. `LICENSE` and `README.md` are copied from the source package
   when present.

5. **Generate shims** by invoking `scripts/generate-shims.mjs` (see below).

6. **Stamp rsl's `package.json`.** Reads the vendored transport's `version`,
   then — still `cd`'d inside the React checkout so `git` reads React's HEAD —
   computes `<sha>`/`<date>` and writes rsl's own `version` +
   `peerDependencies.react` / `.react-dom` per the table above. Stable uses the
   vendored React version verbatim; experimental builds the
   `0.0.0-experimental-<sha>-<date>` string.

The vendored output lands in `vendor/react-server-dom-esm/`. That directory is
gitignored locally but **included in the published npm tarball**. Note: because
the script rewrites `package.json`'s `version`, a throwaway local build should
be followed by `git checkout package.json` if you don't intend to publish — the
script prints this reminder.

### Shim generation — `scripts/generate-shims.mjs`

React's source-tree shim files (in `packages/react-server-dom-esm/`) are ES
modules with `@flow` annotations and aren't directly loadable in Node. React's
own packaging step rewrites them into the conditional-`require` shape consumers
import; rather than run that full packaging step (which fails on unrelated
downstream packages on a clean checkout), this script writes the publishable
shims directly into `vendor/react-server-dom-esm/`. They're stable across React
versions — only the file names inside `cjs/` change.

The shims it writes:

| shim file | shape |
| --- | --- |
| `index.js` | throws — points you at `react-server-dom-esm/client` |
| `client.js` | re-exports `./client.browser` |
| `client.browser.js` | `NODE_ENV`-conditional require of `cjs/…-client.browser.{production,development}.js` |
| `client.node.js` | `NODE_ENV`-conditional require of `cjs/…-client.node.*` |
| `server.js` | throws the *"cannot be used outside a react-server environment … `--conditions react-server`"* error |
| `server.node.js` | named re-export of the server surface from `cjs/…-server.node.*` |
| `static.js` | same throw as `server.js` |
| `static.node.js` | named re-export of `cjs/…-server.node.*` (static re-uses the server build) |

The server/static `*.node` shims re-export an explicit list of named symbols:
`renderToPipeableStream`, `decodeReplyFromBusboy`, `decodeReply`,
`decodeAction`, `decodeFormState`, `registerServerReference`,
`registerClientReference`, `createTemporaryReferenceSet`.

It then **patches the vendored `package.json` exports map**: React's source map
points `./server` and `./static` `default` conditions at the throwing
`./server.js` / `./static.js`; the script repoints them at `./server.node.js` /
`./static.node.js` so the publishable package resolves to a working entry. It
also deletes the source-only `./src/*` exports entry, which doesn't apply to
the vendored package.

This is why, in this React build, `react-server-loader/static` re-exports the
server surface: `react-server-dom-esm` ships no separate static module, so the
static `.node` shim points at the same `server.node` build.

## The "Build + pack" GitHub workflow

`.github/workflows/publish.yml` is a `workflow_dispatch`-only job named
**Build + pack**. The maintainer triggers it with two inputs: `react_ref`
(the facebook/react ref to build against, default `main`) and `channel`
(`experimental` | `stable`, default `experimental`).

Despite the filename, **the workflow never publishes and holds no npm
credentials.** It exists to run the exact `build-rsl.sh` pipeline on a clean
checkout and hand back an inspectable tarball. Steps:

1. Checkout rsl; set up Node 22; install Java 21 (Temurin) for Closure
   Compiler; `corepack enable` for yarn.
2. `npm install`, `npm run build` (the TypeScript surface), `npx vitest --run`
   (unit tests).
3. `bash scripts/build-rsl.sh --channel <channel> --react-ref <react_ref>` —
   the vendoring + stamping pipeline above.
4. Read the publish version back out of `package.json` (build-rsl already
   stamped it — the workflow does not re-derive it), and resolve the dist-tag
   from the channel (`experimental` → `experimental`, otherwise `latest`).
   The dist-tag is **informational only** here; it's applied by the maintainer
   at `npm publish` time.
5. `npm pack`, then upload `react-server-loader-*.tgz` as a workflow artifact
   (30-day retention).
6. Write a run Summary with the React ref, channel, version, dist-tag, and the
   exact `gh run download …` + `npm publish …` commands to publish that
   tarball locally.

## Local publishing — no token on GitHub

Publishing is deliberately a local, manual step so a long-lived npm token never
lives in GitHub. The flow is *build → pack → publish the packed bytes*:

```bash
# build locally (or download the workflow artifact instead)
./scripts/build-rsl.sh --channel stable --react-ref v19.2.7
npm pack
# publish that exact tarball from your own machine
npm publish ./react-server-loader-<version>.tgz \
  --access public \
  --tag <latest|experimental>
```

Use `--tag experimental` for the experimental train so it never moves `latest`.
If you build via the workflow instead, download its artifact and publish that
tarball — the run Summary prints the precise command for the version it built:

```bash
gh run download <run-id> -R <owner>/<repo> -D ./rsl-pub
npm publish ./rsl-pub/react-server-loader-<version>/react-server-loader-<version>.tgz \
  --access public --tag <tag>
```

## The consumer gate — `scripts/verify-release.sh`

rsl's unit tests cover the loader/directive/transformer code, but nothing in
this repo proves the *assembled, packed* package actually renders an RSC tree
end to end. `verify-release.sh` closes that gap so releases can be cut rarely
and confidently instead of chasing patch releases.

```bash
scripts/verify-release.sh                                   # build experimental (default), verify
scripts/verify-release.sh --channel stable --react-ref v19.2.7
scripts/verify-release.sh --tarball ./react-server-loader-19.2.0.tgz
```

What it does:

1. **Obtain the exact publishable tarball.** With no `--tarball`, it runs
   `build-rsl.sh` (passing through `--channel` / `--react-ref`), then
   `npm run build && npm pack`, and picks the newest
   `react-server-loader-*.tgz`. With `--tarball`, it uses the one you hand it.
2. **Install that tarball into a real consumer**, replacing the consumer's
   source link — so it tests the *packaged bytes*, not `src`. The consumer
   defaults to the sibling `../vite-plugin-react-server` (override with
   `CONSUMER_DIR`); it must already have `node_modules`. The original
   `node_modules/react-server-loader` (symlink or directory) is backed up.
3. **Run the consumer's integration suite** against the swapped-in package.
   Default command is `npm run test:build && npm run test:streams` — the
   deterministic full-pipeline slice (server → wire → client RSC render),
   avoiding the flaky dev-server/e2e harness. Override with `VERIFY_TEST_CMD`
   (it's `eval`'d inside the consumer).
4. **Always restore** the consumer's original rsl link on exit (an `EXIT`
   trap), pass or fail.

Green → safe to publish. Red → do not publish; the script exits non-zero with
the failing version named. `npm run verify` is the package-script entry point
to this gate.

## Gotcha: `npm pack` ships whatever `vendor/` you last built

`vendor/` is **gitignored** — it is a build artifact, not source. So the React
channel baked into your tree is invisible to `git status`, and a clean-looking
working tree can still be carrying an experimental transport.

`npm publish` is protected: `prepublishOnly` runs
[`check-publishable.mjs`](../../scripts/check-publishable.mjs), which fails the
publish unless `vendor/react-server-dom-esm`'s stamped version equals
`package.json`'s. **`npm pack` is not.** It only runs `prepack` (a `tsc` build),
so it will happily produce a tarball whose `dist/` is stable-stamped and whose
`vendor/` came from the last experimental build you ran.

That tarball installs without complaint and then fails at runtime, deep inside
the transport, in a way that looks like a bug in the code under test:

```
TypeError: Cannot read properties of undefined (reading 'add')
    at new RequestInstance (.../react-server-dom-esm-server.node.production.js)
```

`TaintRegistryPendingRequests` is an **experimental**-only React internal. The
error means an experimental-vendored transport is running against a React that
doesn't expose it — i.e. the transport and React came from different channels.
It is not a condition problem and not a `use client` problem, though it
convincingly imitates both.

This bites hardest when hand-packing a tarball to try a change against a
consumer (vprs, a demo app), because the consumer's React decides whether you
see it: a stable-React consumer blows up, an `react@experimental` consumer
passes, and you conclude your change works "sometimes".

Before packing a tarball for a consumer, build the vendor for the channel that
consumer runs:

```bash
# check what you're actually holding — these must match
node -p "require('./package.json').version"
node -p "require('./vendor/react-server-dom-esm/package.json').version"

# rebuild the vendor for the target channel first
bash scripts/build-rsl.sh --channel stable   --react-ref v19.2.7
```

Or skip hand-packing entirely and use `./scripts/release.sh --dry-run`, which
builds, guards, gates and packs the same way a real release does.

## End-to-end release checklist

1. `./scripts/build-rsl.sh --channel <c> --react-ref <ref>` — or trigger the
   **Build + pack** workflow with the same inputs.
2. `scripts/verify-release.sh` (or `npm run verify`) — gate the packed tarball
   against vprs. Stop if red.
3. `npm pack` (if not already packed), then
   `npm publish <tgz> --access public --tag <latest|experimental>` from your own
   machine.
4. For a throwaway local build that you don't publish, `git checkout
   package.json` to drop the stamped version/peer.

## See also

- [`scripts/build-rsl.sh`](../../scripts/build-rsl.sh) — vendoring + stamping
- [`scripts/generate-shims.mjs`](../../scripts/generate-shims.mjs) — shim generation
- [`scripts/verify-release.sh`](../../scripts/verify-release.sh) — consumer gate
- [`.github/workflows/publish.yml`](../../.github/workflows/publish.yml) — Build + pack
- README *Versioning* / *Building a release* — the consumer-facing summary
