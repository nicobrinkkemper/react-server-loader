// The webpack transport's module-loading contract, owned in one place.
//
// react-server-dom-webpack does not import its module system — it reads
// bundler-injected globals: `__webpack_require__` (sync module lookup, plus a
// `.u` chunk-filename template the production client reads at MODULE-EVAL
// time), `__webpack_chunk_load__` (async chunk fetch), and — development
// builds only — `__webpack_get_script_filename__` instead of `.u`. Any
// non-webpack host (a Vite build, a baked bundle, an edge runtime) must
// provide those globals itself, and must provide them BEFORE the transport
// module evaluates.
//
// This helper is that provision. Two supported backings, composable:
//   - `modules`: a static registry (a composed/baked bundle's closed module
//     set) — resolved synchronously, chunk loads are bookkeeping only.
//   - `load`: an async loader bridged through the chunk protocol. This works
//     because React always awaits `__webpack_chunk_load__` for every chunk
//     listed in a reference's metadata BEFORE its sync `__webpack_require__`
//     — so the loader resolves and caches during preload, and the sync
//     require reads the cache. (Verified against the vendored transport;
//     the smoke tests exercise exactly this ordering per React build.)
//
// Chunk-id convention: a chunk id is either a module id, or `moduleId#export`
// for per-export loaders (the reference-gate adapter). The cache key is
// always the module id; per-export loads MERGE into the module's entry.
//
// The globals are process-wide by the TRANSPORT's design — one registry per
// process. A second install merges into the first (static modules and
// loaders accumulate); a foreign `__webpack_require__` (a real webpack
// runtime, or another library's shim) is refused unless `force: true`.

export type ModuleExports = Record<string, unknown>;

export interface WebpackGlobalsOptions {
  /** Static closed registry: hosted module id -> module exports. */
  modules?: Record<string, ModuleExports>;
  /**
   * Async loader for chunk ids not covered by `modules`. Receives the full
   * chunk id (possibly `moduleId#export`); resolved exports merge into the
   * module's cache entry under the id before `#`.
   */
  load?: (chunkId: string) => Promise<ModuleExports>;
  /**
   * Chunk-filename template (`__webpack_require__.u` in production builds,
   * `__webpack_get_script_filename__` in development builds). Defaults to the
   * identity — correct for a composed bundle where nothing is fetched by URL.
   */
  chunkFilename?: (chunkId: string) => string;
  /** Overwrite a foreign (non-rsl) `__webpack_require__` instead of throwing. */
  force?: boolean;
}

export interface WebpackGlobalsHandle {
  /** Remove the globals this install created (restores prior values). */
  uninstall(): void;
}

const RSL_MARKER = Symbol.for("react-server-loader.webpack-runtime");

type InstalledState = {
  modules: Map<string, ModuleExports>;
  loaded: Map<string, ModuleExports>;
  loaders: Array<(chunkId: string) => Promise<ModuleExports>>;
  chunkFilename: (chunkId: string) => string;
};

type MarkedRequire = ((id: string) => ModuleExports) & {
  u: (chunkId: string) => string;
  [RSL_MARKER]?: InstalledState;
};

const g = globalThis as typeof globalThis & {
  __webpack_require__?: MarkedRequire;
  __webpack_chunk_load__?: (chunkId: string) => Promise<unknown>;
  __webpack_get_script_filename__?: (chunkId: string) => string;
};

const moduleIdOf = (chunkId: string): string => {
  const hash = chunkId.indexOf("#");
  return hash === -1 ? chunkId : chunkId.slice(0, hash);
};

export function installWebpackGlobals(
  options: WebpackGlobalsOptions = {}
): WebpackGlobalsHandle {
  const { modules, load, chunkFilename, force = false } = options;

  const existing = g.__webpack_require__;
  const ours = existing?.[RSL_MARKER];

  if (existing && !ours && !force) {
    throw new Error(
      "installWebpackGlobals: __webpack_require__ is already defined by something " +
        "else (a real webpack runtime, or another shim). Refusing to clobber it — " +
        "pass { force: true } only if you are certain this environment has no " +
        "live webpack module system."
    );
  }

  if (ours) {
    // Merge into the existing rsl install: registries and loaders accumulate.
    if (modules) {
      for (const [id, exports] of Object.entries(modules)) ours.modules.set(id, exports);
    }
    if (load) ours.loaders.push(load);
    if (chunkFilename) ours.chunkFilename = chunkFilename;
    return { uninstall: noopUninstall };
  }

  const state: InstalledState = {
    modules: new Map(Object.entries(modules ?? {})),
    loaded: new Map(),
    loaders: load ? [load] : [],
    chunkFilename: chunkFilename ?? ((chunkId) => String(chunkId)),
  };

  const require = ((id: string): ModuleExports => {
    const fromStatic = state.modules.get(id);
    if (fromStatic) return fromStatic;
    const fromLoaded = state.loaded.get(id);
    if (fromLoaded) return fromLoaded;
    throw new Error(
      `installWebpackGlobals: unknown module "${id}". It is neither in the static ` +
        "registry nor chunk-loaded. If it is served by an async loader, the " +
        "reference's metadata must list it in `chunks` so React preloads it " +
        "before this sync require."
    );
  }) as MarkedRequire;
  require.u = (chunkId: string) => state.chunkFilename(chunkId);
  require[RSL_MARKER] = state;

  const chunkLoad = async (chunkId: string): Promise<void> => {
    const id = moduleIdOf(String(chunkId));
    if (state.modules.has(id)) return; // static — nothing to fetch
    const errors: unknown[] = [];
    for (const loader of state.loaders) {
      try {
        const exports = await loader(String(chunkId));
        const entry = state.loaded.get(id) ?? {};
        Object.assign(entry, exports);
        state.loaded.set(id, entry);
        return;
      } catch (err) {
        errors.push(err);
      }
    }
    throw new Error(
      `installWebpackGlobals: no registry or loader could resolve chunk "${chunkId}"` +
        (errors.length
          ? ` (loader errors: ${errors.map((e) => (e as Error)?.message ?? String(e)).join("; ")})`
          : " (no async loader configured)")
    );
  };

  const prior = {
    require: g.__webpack_require__,
    chunkLoad: g.__webpack_chunk_load__,
    scriptFilename: g.__webpack_get_script_filename__,
  };

  g.__webpack_require__ = require;
  g.__webpack_chunk_load__ = chunkLoad;
  // Development transport builds read this global instead of `require.u`.
  g.__webpack_get_script_filename__ = (chunkId: string) => state.chunkFilename(chunkId);

  let uninstalled = false;
  return {
    uninstall() {
      if (uninstalled) return;
      uninstalled = true;
      g.__webpack_require__ = prior.require;
      g.__webpack_chunk_load__ = prior.chunkLoad;
      g.__webpack_get_script_filename__ = prior.scriptFilename;
    },
  };
}

function noopUninstall(): void {
  // Merged installs share the first install's globals; only the handle that
  // created them can remove them.
}
