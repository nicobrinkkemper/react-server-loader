import { describe, it, expect, vi } from "vitest";
import { createReferenceGate } from "../../src/references/index.js";
import type { ModuleExports } from "../../src/references/index.js";

/**
 * Unit suite for the reference gate — the manifest-backed allowlist that
 * replaces the vendored transport's open `startsWith(baseURL) + import(id)`
 * resolution.
 *
 * The security claims under test:
 *   - a sealed gate rejects any id whose module was never registered, so a
 *     forged id (including a `../` traversal) cannot resolve a module at all —
 *     the bound importer is never even consulted,
 *   - a registered module cannot be used to reach an export that is not an
 *     actual registered reference,
 *   - the incoming id is only ever a dictionary KEY: resolution imports the
 *     build-bound module, never a path derived from the id,
 *   - dev `open` mode may fall back to an on-demand resolver, but that is a
 *     convenience, not a boundary, and the registered-reference check still
 *     applies.
 */

const SERVER_TAG = Symbol.for("react.server.reference");
const CLIENT_TAG = Symbol.for("react.client.reference");

/** A stand-in for what `registerServerReference` stamps onto an action. */
function serverRef<F extends (...args: never[]) => unknown>(fn: F): F {
  (fn as { $$typeof?: symbol }).$$typeof = SERVER_TAG;
  return fn;
}

/** A stand-in for `registerClientReference`'s tagged proxy. */
function clientRef(name: string): Record<string, unknown> {
  return { $$typeof: CLIENT_TAG, $$id: name };
}

describe("createReferenceGate", () => {
  it("rejects an unregistered server id when sealed (never imports it)", async () => {
    const gate = createReferenceGate({ mode: "sealed" });
    const forged = vi.fn(async (): Promise<ModuleExports> => ({}));
    gate.register({ id: "/app/actions.ts", load: forged, kind: "server" });
    gate.seal();

    await expect(
      gate.resolveServerReference("/app/secrets.ts#stealCookies"),
    ).rejects.toThrow(/Unknown server reference/);
  });

  it("rejects a `../` traversal id structurally (no importer runs)", async () => {
    const gate = createReferenceGate({ mode: "sealed" });
    const known = vi.fn(async (): Promise<ModuleExports> => ({
      doThing: serverRef(() => "ok"),
    }));
    gate.register({ id: "/app/actions.ts", load: known, kind: "server" });
    gate.seal();

    await expect(
      gate.resolveServerReference("../../../../etc/passwd#x"),
    ).rejects.toThrow(/Unknown server reference/);
    // The traversal id is not a key, so the only registered importer never ran.
    expect(known).not.toHaveBeenCalled();
  });

  it("rejects an export that is not a registered server reference", async () => {
    const gate = createReferenceGate({ mode: "sealed" });
    gate.register({
      id: "/app/actions.ts",
      // The module exists and is registered, but `helper` was never marked.
      load: async () => ({ helper: () => "not an action" }),
      kind: "server",
    });
    gate.seal();

    await expect(
      gate.resolveServerReference("/app/actions.ts#helper"),
    ).rejects.toThrow(/not a registered server reference/);
  });

  it("resolves a legit server reference to its callable", async () => {
    const gate = createReferenceGate({ mode: "sealed" });
    const action = serverRef(() => "result");
    gate.register({
      id: "/app/actions.ts",
      load: async () => ({ submit: action }),
      kind: "server",
    });
    gate.seal();

    const resolved = await gate.resolveServerReference("/app/actions.ts#submit");
    expect(resolved).toBe(action);
    expect((resolved as () => string)()).toBe("result");
  });

  it("resolves a legit client reference", async () => {
    const gate = createReferenceGate({ mode: "sealed" });
    const ref = clientRef("/app/widget.tsx#Widget");
    gate.register({
      id: "/app/widget.tsx",
      load: async () => ({ Widget: ref }),
      kind: "client",
    });
    gate.seal();

    expect(await gate.resolveClientReference("/app/widget.tsx#Widget")).toBe(
      ref,
    );
  });

  it("rejects a kind mismatch (server id registered as client)", async () => {
    const gate = createReferenceGate({ mode: "sealed" });
    gate.register({
      id: "/app/widget.tsx",
      load: async () => ({ Widget: clientRef("x") }),
      kind: "client",
    });
    gate.seal();

    await expect(
      gate.resolveServerReference("/app/widget.tsx#Widget"),
    ).rejects.toThrow(/not server/);
  });

  it("open mode falls back to devResolve for an unregistered id and warns", async () => {
    const warn = vi.fn();
    const devResolve = vi.fn(async (): Promise<ModuleExports> => ({
      onDemand: serverRef(() => "lazy"),
    }));
    const gate = createReferenceGate({
      mode: "open",
      devResolve,
      logger: { info() {}, warn, error() {} },
    });

    const resolved = await gate.resolveServerReference("/app/late.ts#onDemand");
    expect((resolved as () => string)()).toBe("lazy");
    expect(devResolve).toHaveBeenCalledWith("/app/late.ts");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("open mode still rejects an unregistered id with no devResolve", async () => {
    const gate = createReferenceGate({ mode: "open" });
    await expect(
      gate.resolveServerReference("/app/late.ts#x"),
    ).rejects.toThrow(/Unknown server reference/);
  });

  it("refuses registration after sealing", () => {
    const gate = createReferenceGate({ mode: "sealed" });
    gate.seal();
    expect(() =>
      gate.register({ id: "/app/a.ts", load: async () => ({}), kind: "server" }),
    ).toThrow(/sealed/);
  });

  it("rejects a malformed id", async () => {
    const gate = createReferenceGate({ mode: "sealed" });
    gate.seal();
    await expect(gate.resolveServerReference("/app/a.ts")).rejects.toThrow(
      /Invalid reference id/,
    );
  });
});
