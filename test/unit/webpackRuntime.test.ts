import { describe, it, expect, afterEach } from "vitest";
import {
  installWebpackGlobals,
  gateModuleLoader,
} from "../../src/webpack-runtime/index.js";
import { createReferenceGate } from "../../src/references/gate.js";

// The webpack transport's module-loading globals, provided from a closed
// registry. These tests pin the contract the vendored transport depends on:
// sync require over static/preloaded modules, async chunk_load bridging,
// both chunk-filename spellings (prod `.u`, dev `__webpack_get_script_filename__`),
// merge-on-reinstall, and refusal to clobber a foreign runtime.

type G = typeof globalThis & {
  __webpack_require__?: ((id: string) => Record<string, unknown>) & {
    u?: (c: string) => string;
  };
  __webpack_chunk_load__?: (c: string) => Promise<unknown>;
  __webpack_get_script_filename__?: (c: string) => string;
};
const g = globalThis as G;

const handles: Array<{ uninstall(): void }> = [];
const install = (...args: Parameters<typeof installWebpackGlobals>) => {
  const h = installWebpackGlobals(...args);
  handles.push(h);
  return h;
};

afterEach(() => {
  while (handles.length) handles.pop()!.uninstall();
  // Merged installs share the first handle's globals; make leaks loud.
  expect(g.__webpack_require__).toBeUndefined();
});

describe("installWebpackGlobals", () => {
  it("serves static registry modules through the sync require", () => {
    const exportsObj = { default: () => "counter" };
    install({ modules: { "/assets/Counter-abc.js": exportsObj } });
    expect(g.__webpack_require__!("/assets/Counter-abc.js")).toBe(exportsObj);
  });

  it("installs both chunk-filename spellings (prod .u and dev global)", () => {
    install({ chunkFilename: (c) => `/chunks/${c}.js` });
    expect(g.__webpack_require__!.u!("x")).toBe("/chunks/x.js");
    expect(g.__webpack_get_script_filename__!("x")).toBe("/chunks/x.js");
  });

  it("bridges an async loader through chunk_load into the sync require", async () => {
    const loaded = { increment: () => 42 };
    install({ load: async () => loaded });
    // Sync require before preload must throw — that IS the transport contract.
    expect(() => g.__webpack_require__!("srv/actions.js")).toThrow(/chunks/);
    await g.__webpack_chunk_load__!("srv/actions.js");
    expect(g.__webpack_require__!("srv/actions.js")).toEqual(loaded);
  });

  it("merges per-export chunk loads under one module id", async () => {
    install({
      load: async (chunkId) => {
        const name = chunkId.split("#")[1];
        return { [name]: `ref:${name}` };
      },
    });
    await g.__webpack_chunk_load__!("srv/actions.js#a");
    await g.__webpack_chunk_load__!("srv/actions.js#b");
    expect(g.__webpack_require__!("srv/actions.js")).toEqual({
      a: "ref:a",
      b: "ref:b",
    });
  });

  it("chunk_load is a no-op for static modules and rejects unknown chunks", async () => {
    install({ modules: { known: { x: 1 } } });
    await expect(g.__webpack_chunk_load__!("known")).resolves.toBeUndefined();
    await expect(g.__webpack_chunk_load__!("unknown")).rejects.toThrow(/no registry or loader/);
  });

  it("a second install merges modules and loaders instead of clobbering", async () => {
    install({ modules: { a: { v: "a" } } });
    install({ modules: { b: { v: "b" } }, load: async () => ({ v: "loaded" }) });
    expect(g.__webpack_require__!("a")).toEqual({ v: "a" });
    expect(g.__webpack_require__!("b")).toEqual({ v: "b" });
    await g.__webpack_chunk_load__!("c");
    expect(g.__webpack_require__!("c")).toEqual({ v: "loaded" });
  });

  it("refuses to clobber a foreign __webpack_require__ without force", () => {
    const foreign = Object.assign((id: string) => ({ id }), { u: (c: string) => c });
    g.__webpack_require__ = foreign;
    try {
      expect(() => installWebpackGlobals({})).toThrow(/already defined/);
      const h = installWebpackGlobals({ force: true, modules: { m: { ok: true } } });
      expect(g.__webpack_require__!("m")).toEqual({ ok: true });
      h.uninstall();
      expect(g.__webpack_require__).toBe(foreign);
    } finally {
      delete g.__webpack_require__;
    }
  });
});

describe("gateModuleLoader", () => {
  const SERVER_REF = Symbol.for("react.server.reference");
  const makeAction = () =>
    Object.assign(async (n: number) => n + 1, { $$typeof: SERVER_REF });

  it("resolves a server reference through a sealed gate into the chunk cache", async () => {
    const increment = makeAction();
    const gate = createReferenceGate({ mode: "sealed" });
    gate.register({
      id: "/assets/actions-def.js",
      load: async () => ({ increment }),
      kind: "server",
      exportNames: ["increment"],
    });
    gate.seal();

    install({ load: gateModuleLoader(gate) });
    await g.__webpack_chunk_load__!("/assets/actions-def.js#increment");
    const mod = g.__webpack_require__!("/assets/actions-def.js");
    expect(mod.increment).toBe(increment);
  });

  it("rejects ids outside the sealed set and ids without an export part", async () => {
    const gate = createReferenceGate({ mode: "sealed" });
    gate.seal();
    install({ load: gateModuleLoader(gate) });
    await expect(g.__webpack_chunk_load__!("/assets/evil.js#pwn")).rejects.toThrow();
    const loader = gateModuleLoader(gate);
    await expect(loader("/assets/no-export.js")).rejects.toThrow(/#<export>/);
  });
});
