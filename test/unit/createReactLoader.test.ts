import { describe, it, expect, vi } from "vitest";
import type { LoadHook, LoadHookContext } from "node:module";
import { createReactLoader } from "../../src/loader/index.js";
import { createReferenceGate } from "../../src/references/index.js";

/**
 * Helpers — stand-ins for what Node would pass into the loader chain.
 */
const fileURL = (path: string) => `file://${path}`;

const stubContext = (
  format: LoadHookContext["format"] = "module",
): LoadHookContext => ({
  format,
  conditions: [],
  importAttributes: {},
});

const stubNextLoad = (source: string, format: LoadHookContext["format"] = "module") =>
  vi.fn(async () => ({
    format,
    source,
    shortCircuit: true as const,
  }));

const stubID = vi.fn((filePath: string) => filePath);

describe("createReactLoader / load hook", () => {
  it("returns the wrapped { load, resolve } pair", () => {
    const { load, resolve } = createReactLoader({ moduleID: stubID });
    expect(typeof load).toBe("function");
    expect(typeof resolve).toBe("function");
  });

  it("passes non-module formats through to nextLoad untouched", async () => {
    const { load } = createReactLoader({ moduleID: stubID });
    const next = stubNextLoad("blob", "commonjs");
    const ctx = stubContext("commonjs");

    const result = await load(fileURL("/x.cjs"), ctx, next as unknown as LoadHook);

    expect(next).toHaveBeenCalledWith(fileURL("/x.cjs"), ctx);
    expect(result.format).toBe("commonjs");
    // No transform for non-module formats — source comes back unchanged.
    expect(result.source).toBe("blob");
  });

  it("rewrites `import { X } from \"react\"` into a default import + destructure", async () => {
    const { load } = createReactLoader({ moduleID: stubID });
    const source = `import { useState, useEffect } from "react";\nexport const x = 1;`;
    const next = stubNextLoad(source);

    const result = await load(
      fileURL("/foo.js"),
      stubContext(),
      next as unknown as LoadHook,
    );

    const out = String(result.source);
    // The named-import line is replaced with a default-import alias and a
    // destructure of the requested names against that alias. The rewrite
    // preserves the original spacing inside the destructure braces.
    expect(out).toMatch(/import __react_cjs_\d+ from "react"/);
    expect(out).toMatch(/const \{\s*useState, useEffect\s*\} = __react_cjs_\d+/);
    expect(out).not.toMatch(/import\s*\{[^}]*\}\s*from\s*"react"/);
  });

  it("invokes nextLoad — not the moduleID callback — for modules that are neither client nor server", async () => {
    const moduleID = vi.fn((filePath: string) => filePath);
    const onTransform = vi.fn();
    const { load } = createReactLoader({ moduleID, onTransform });
    const next = stubNextLoad('export const noBoundary = 1;');

    await load(fileURL("/plain.js"), stubContext(), next as unknown as LoadHook);

    expect(next).toHaveBeenCalled();
    expect(moduleID).not.toHaveBeenCalled();
    expect(onTransform).not.toHaveBeenCalled();
  });

  it("recognises a top-level `\"use client\"` as a client module and invokes the moduleID + onTransform callbacks", async () => {
    const moduleID = vi.fn((filePath: string) => `/hosted${filePath}`);
    const onTransform = vi.fn();
    const { load } = createReactLoader({ moduleID, onTransform });
    const source = `"use client";\nexport function Counter() {}`;
    const next = stubNextLoad(source);

    await load(
      fileURL("/Counter.tsx"),
      stubContext(),
      next as unknown as LoadHook,
    );

    expect(moduleID).toHaveBeenCalledTimes(1);
    expect(moduleID.mock.calls[0]![0]).toBe("/Counter.tsx");
    // The third arg signals whether the directive engine flagged this as a
    // client module — should be true on the directive path.
    expect(moduleID.mock.calls[0]![2]).toBe(true);

    expect(onTransform).toHaveBeenCalledTimes(1);
    const info = onTransform.mock.calls[0]![0];
    expect(info.url).toBe(fileURL("/Counter.tsx"));
    expect(info.filePath).toBe("/Counter.tsx");
    expect(info.transformedId).toBe("/hosted/Counter.tsx");
    expect(info.isClient).toBe(true);
    expect(info.isServer).toBe(false);
    expect(typeof info.source).toBe("string");
  });

  it("recognises a file-level `\"use server\"` and routes it through the server branch", async () => {
    const moduleID = vi.fn((filePath: string) => filePath);
    const onTransform = vi.fn();
    const { load } = createReactLoader({ moduleID, onTransform });
    const source = `"use server";\nexport async function loadUser(id) { return id; }`;
    const next = stubNextLoad(source);

    await load(
      fileURL("/actions.ts"),
      stubContext(),
      next as unknown as LoadHook,
    );

    expect(onTransform).toHaveBeenCalledTimes(1);
    const info = onTransform.mock.calls[0]![0];
    expect(info.isServer).toBe(true);
    expect(info.isClient).toBe(false);
    // moduleID for server modules — the directive engine doesn't claim the
    // module as client-by-directive, so the third arg is false.
    expect(moduleID.mock.calls[0]![2]).toBe(false);
  });

  it("threads loader option overrides into the load path's client-detection branch", async () => {
    // Sentinel check — pass a loader override whose effect would only
    // show up if the override reached the transformer call site. Here we
    // override `isClientComponentCode` to always return true so the load
    // hook routes the input as a client module even though the source
    // has no `"use client"` directive.
    const onTransform = vi.fn();
    const moduleID = vi.fn((filePath: string) => filePath);
    const { load } = createReactLoader({
      moduleID,
      onTransform,
      loader: {
        isClientComponentCode: () => true,
      },
    });
    // No directive — the directive engine won't flag this as client.
    // The override's isClientComponentCode is what should push it down
    // the client path.
    const next = stubNextLoad('export function Counter() {}');

    await load(
      fileURL("/Counter.tsx"),
      stubContext(),
      next as unknown as LoadHook,
    );

    // onTransform fired → the load hook reached the client branch via
    // the loader-override path, not the directive-engine path.
    expect(onTransform).toHaveBeenCalledTimes(1);
    const info = onTransform.mock.calls[0]![0];
    expect(info.isClient).toBe(true);
    // The directive engine itself didn't flag this module, so the
    // moduleID callback is called with `isClientByDirective=false`.
    expect(moduleID.mock.calls[0]![2]).toBe(false);
  });
});

describe("createReactLoader / reference gate wiring", () => {
  it("registers a transformed server boundary keyed by its hosted id", async () => {
    const gate = createReferenceGate({ mode: "open" });
    const register = vi.spyOn(gate, "register");
    const { load } = createReactLoader({
      moduleID: (filePath) => `/hosted${filePath}`,
      gate,
    });
    const next = stubNextLoad(
      `"use server";\nexport async function submit() {}`,
    );

    await load(fileURL("/actions.ts"), stubContext(), next as unknown as LoadHook);

    expect(register).toHaveBeenCalledTimes(1);
    const entry = register.mock.calls[0]![0];
    expect(entry.id).toBe("/hosted/actions.ts");
    expect(entry.kind).toBe("server");
    expect(typeof entry.load).toBe("function");
  });

  it("registers a client boundary as kind 'client'", async () => {
    const gate = createReferenceGate({ mode: "open" });
    const register = vi.spyOn(gate, "register");
    const { load } = createReactLoader({
      moduleID: (filePath) => `/hosted${filePath}`,
      gate,
    });
    const next = stubNextLoad(`"use client";\nexport function Counter() {}`);

    await load(fileURL("/Counter.tsx"), stubContext(), next as unknown as LoadHook);

    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0]![0].kind).toBe("client");
  });

  it("does not register non-boundary modules", async () => {
    const gate = createReferenceGate({ mode: "open" });
    const register = vi.spyOn(gate, "register");
    const { load } = createReactLoader({ moduleID: stubID, gate });
    const next = stubNextLoad("export const x = 1;");

    await load(fileURL("/plain.js"), stubContext(), next as unknown as LoadHook);

    expect(register).not.toHaveBeenCalled();
  });

  it("composes with onTransform — both fire for one boundary", async () => {
    const gate = createReferenceGate({ mode: "open" });
    const register = vi.spyOn(gate, "register");
    const onTransform = vi.fn();
    const { load } = createReactLoader({ moduleID: stubID, gate, onTransform });
    const next = stubNextLoad(`"use server";\nexport async function a() {}`);

    await load(fileURL("/a.ts"), stubContext(), next as unknown as LoadHook);

    expect(onTransform).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledTimes(1);
  });
});

describe("createReactLoader / resolve hook", () => {
  it("passes the resolution call through untouched", async () => {
    const { resolve } = createReactLoader({ moduleID: stubID });
    const nextResolve = vi.fn(async () => ({
      url: "file:///resolved.js",
      format: "module" as const,
      shortCircuit: true as const,
    }));
    // node:module's resolve hook context includes parentURL + conditions +
    // importAttributes; for the unit test the loader doesn't read any of
    // them so a minimal stub suffices.
    const ctx = {
      parentURL: undefined as string | undefined,
      conditions: [] as string[],
      importAttributes: {} as Record<string, string>,
    };

    const result = await resolve("./foo.js", ctx, nextResolve as Parameters<typeof resolve>[2]);

    expect(nextResolve).toHaveBeenCalledWith("./foo.js", ctx);
    expect(result.url).toBe("file:///resolved.js");
  });
});
