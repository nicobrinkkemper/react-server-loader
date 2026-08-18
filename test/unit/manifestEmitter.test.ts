import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  emitReferenceManifest,
  createManifestCollector,
} from "../../src/manifest/index.js";
import { createReferenceGate } from "../../src/references/index.js";

/**
 * Unit suite for the reference-manifest emitter — the build pass that turns an
 * enumeration of client/server references into an emitted registration module.
 *
 * The claims under test:
 *   - the emitted artifact is a real module: imported from disk, it registers
 *     every entry against an injected gate and seals it, and the sealed gate
 *     resolves a reference with ZERO dynamic `import()` (the loads are
 *     statically-imported namespaces),
 *   - the emitted source contains no `import(` substring at all — the
 *     closed-dictionary property holds by construction, not by runtime luck,
 *   - after sealing, an unknown id and a non-enumerated export both throw (the
 *     emitted `exportNames` allowlist is the authority).
 */

const CLIENT_TAG = Symbol.for("react.client.reference");
const SERVER_TAG = Symbol.for("react.server.reference");

// Fixture modules stand in for the transformed output the bundler resolves:
// their exports carry the runtime tags React's register calls would stamp.
const BUTTON_FIXTURE = `export const Button = { $$typeof: Symbol.for("react.client.reference"), $$id: "/components/Button.js#Button" };
export const Hidden = { $$typeof: Symbol.for("react.client.reference"), $$id: "/components/Button.js#Hidden" };
`;
const ACTIONS_FIXTURE = `export const addItem = Object.assign(() => "added", { $$typeof: Symbol.for("react.server.reference") });
`;

const ENTRIES = [
  {
    id: "/components/Button.js",
    specifier: "./components/Button.js",
    kind: "client",
    // Hidden is a real reference in the fixture but the build never saw it.
    exportNames: ["Button"],
  },
  {
    id: "/actions.js",
    specifier: "./actions.js",
    kind: "server",
    exportNames: ["addItem"],
  },
] as const;

describe("emitReferenceManifest", () => {
  let dir: string;
  let registerReferences: (
    gate: unknown,
    options?: { seal?: boolean },
  ) => void;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "rsl-manifest-"));
    await mkdir(join(dir, "components"));
    await writeFile(join(dir, "components", "Button.js"), BUTTON_FIXTURE);
    await writeFile(join(dir, "actions.js"), ACTIONS_FIXTURE);
    await writeFile(
      join(dir, "manifest.js"),
      emitReferenceManifest(ENTRIES),
    );
    ({ registerReferences } = await import(
      pathToFileURL(join(dir, "manifest.js")).href
    ));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("emits source with zero dynamic import", () => {
    expect(emitReferenceManifest(ENTRIES)).not.toContain("import(");
  });

  it("registers and seals: a manifest reference resolves through the gate", async () => {
    const gate = createReferenceGate({ mode: "sealed" });
    registerReferences(gate);
    expect(gate.sealed).toBe(true);
    expect(gate.size).toBe(2);

    const button = await gate.resolveClientReference(
      "/components/Button.js#Button",
    );
    expect((button as { $$typeof: symbol }).$$typeof).toBe(CLIENT_TAG);

    const addItem = await gate.resolveServerReference("/actions.js#addItem");
    expect((addItem as { $$typeof?: symbol }).$$typeof).toBe(SERVER_TAG);
    expect((addItem as () => string)()).toBe("added");
  });

  it("rejects an unknown id after seal", async () => {
    const gate = createReferenceGate({ mode: "sealed" });
    registerReferences(gate);
    await expect(
      gate.resolveClientReference("/components/Other.js#Widget"),
    ).rejects.toThrow(/Unknown client reference/);
  });

  it("rejects an export outside the emitted exportNames allowlist", async () => {
    const gate = createReferenceGate({ mode: "sealed" });
    registerReferences(gate);
    // Hidden IS a real tagged reference in the fixture — the emitted
    // enumeration, not the runtime tag, is the authority.
    await expect(
      gate.resolveClientReference("/components/Button.js#Hidden"),
    ).rejects.toThrow(/not in the reference allowlist/);
  });

  it("seal:false leaves the gate open for further registration", () => {
    const gate = createReferenceGate({ mode: "sealed" });
    registerReferences(gate, { seal: false });
    expect(gate.sealed).toBe(false);
    gate.register({
      id: "/late.js",
      kind: "client",
      load: () => ({}),
    });
    expect(gate.size).toBe(3);
  });

  it("throws on duplicate entry ids", () => {
    expect(() =>
      emitReferenceManifest([ENTRIES[0], ENTRIES[0]]),
    ).toThrow(/Duplicate manifest entry/);
  });
});

describe("createManifestCollector", () => {
  it("maps transform records to emitter entries", () => {
    const collector = createManifestCollector({
      specifier: (record) => `.${record.transformedModuleId}`,
    });
    collector.onTransform({
      moduleId: "/src/components/Button.tsx",
      transformedModuleId: "/components/Button.js",
      kind: "client",
      exportNames: ["Button"],
    });
    expect(collector.entries()).toEqual([
      {
        id: "/components/Button.js",
        specifier: "./components/Button.js",
        kind: "client",
        exportNames: ["Button"],
      },
    ]);
  });

  it("replaces an earlier record for the same hosted id", () => {
    const collector = createManifestCollector();
    collector.onTransform({
      moduleId: "/src/a.tsx",
      transformedModuleId: "/a.js",
      kind: "client",
      exportNames: ["A"],
    });
    collector.onTransform({
      moduleId: "/src/a.tsx",
      transformedModuleId: "/a.js",
      kind: "client",
      exportNames: ["A", "B"],
    });
    const entries = collector.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.exportNames).toEqual(["A", "B"]);
    // Default specifier is the real module id.
    expect(entries[0]?.specifier).toBe("/src/a.tsx");
  });
});
