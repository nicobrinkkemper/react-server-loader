# react-server-loader documentation

Documentation for `react-server-loader` (rsl) — React, packaged with a
native-ESM workflow in mind: a vendored `react-server-dom-esm` transport, a
directive engine, source-to-source transformer primitives, and a Node ESM
loader factory.

Start at the [README](../README.md) for the overview, install, and a
no-bundler quickstart. The guides below go deeper.

## Consumer guides

- **[Getting started](getting-started.md)** — install the two release trains
  and run an end-to-end "render RSC with no bundler" example with plain
  `node`.
- **[Integrating into a bundler or framework](integrating.md)** — wire rsl's
  `transform` hook and server loader into a bundler/framework, with Vite as
  the worked example.
- **[API reference](api-reference.md)** — per-subpath reference for the public
  API: `loader`, `directives`, `transformer`, and the transport subpaths.
- **[Versioning](versioning.md)** — the stable and experimental trains, the
  peer-dependency contract, and why `react` / `react-dom` must match the
  vendored transport.
- **[Troubleshooting](troubleshooting.md)** — symptom → cause → fix for the
  common failures: version skew, the `react-server` condition, peer-dep
  errors, and experimental dist-tag drift.

## Internals

Implementation detail for contributors and releasers. Consumers don't need
these.

- **[Architecture](internals/architecture.md)** — the four layers (transport,
  directive engine, transformer, loader) and how a source module flows
  through them to RSC output.
- **[Directive engine](internals/directive-engine.md)** — the regex pass, the
  AST-driven directive analysis, and the type-guard/name-resolution helpers.
- **[Transformer internals](internals/transformer.md)** — the transform
  primitives: client stub-and-erase, server keep-and-register, non-server
  strip-only, and the source-map machinery.
- **[Vendoring & publishing](internals/vendoring-and-publishing.md)** — how
  `build-rsl.sh` vendors the transport and stamps the version, shim
  generation, and the local token-free publish + verify-release gate.
