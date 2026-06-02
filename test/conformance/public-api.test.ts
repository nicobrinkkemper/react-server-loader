import { describe, it, expect } from "vitest";

// Conformance: rsl delivers the public API the docs claim, resolved through
// the real package `exports` map (self-import, exactly as a consumer would),
// plus the documented tooling behaviours. The vendored transport
// (/server, /client, /static) needs `react` and is covered separately by
// test/conformance/transport.test.ts.

describe("public API surface — resolves via the exports map", () => {
  it("react-server-loader/loader", async () => {
    const m = await import("react-server-loader/loader");
    expect(m.createReactLoader).toBeTypeOf("function");
    expect(m.NULL_LOGGER).toBeTypeOf("object");
    expect(m.CONSOLE_LOGGER).toBeTypeOf("object");
  });

  it("react-server-loader/directives", async () => {
    const m = await import("react-server-loader/directives");
    expect(m.detectClientModule).toBeTypeOf("function");
    expect(m.sourceHasTopLevelClientDirective).toBeTypeOf("function");
    expect(m.analyzeModule).toBeTypeOf("function");
  });

  it("react-server-loader/transformer", async () => {
    const m = await import("react-server-loader/transformer");
    expect(m.createTransformer).toBeTypeOf("function");
    expect(m.parse).toBeTypeOf("function");
    expect(m.transformModule).toBeTypeOf("function");
  });

  it("react-server-loader (root) re-exports the headline three", async () => {
    const m = await import("react-server-loader");
    expect(m.createReactLoader).toBeTypeOf("function");
    expect(m.detectClientModule).toBeTypeOf("function");
    expect(m.createTransformer).toBeTypeOf("function");
  });
});

describe("documented behaviour — directives", () => {
  it("detectClientModule flags a use-client module, not a server one", async () => {
    const { detectClientModule } = await import("react-server-loader/directives");
    expect(
      detectClientModule({ source: '"use client";\nexport const C = () => null;', moduleId: "/C.js" })
    ).toBe(true);
    expect(
      detectClientModule({ source: "export const S = () => null;", moduleId: "/S.js" })
    ).toBe(false);
  });

  it("sourceHasTopLevelClientDirective is a fast string-level check", async () => {
    const { sourceHasTopLevelClientDirective } = await import("react-server-loader/directives");
    expect(sourceHasTopLevelClientDirective('"use client";\nexport const x = 1;')).toBe(true);
    expect(sourceHasTopLevelClientDirective("export const x = 1;")).toBe(false);
  });
});

describe("documented behaviour — loader", () => {
  it("createReactLoader accepts every documented option and returns load + resolve", async () => {
    const { createReactLoader, NULL_LOGGER } = await import("react-server-loader/loader");
    const onTransform = () => {};
    const { load, resolve } = createReactLoader({
      moduleID: (filePath: string) => filePath,
      loader: {},
      verbose: false,
      logger: NULL_LOGGER,
      onTransform,
    });
    expect(load).toBeTypeOf("function");
    expect(resolve).toBeTypeOf("function");
  });
});

describe("documented behaviour — transformer", () => {
  it("parse returns { ast, code, map }", async () => {
    const { parse } = await import("react-server-loader/transformer");
    const result = parse('"use client";\nexport const x = 1;');
    expect(result.ast).toBeTypeOf("object");
    expect(result.ast.type).toBe("Program");
    expect(result.code).toBeTypeOf("string");
    expect("map" in result).toBe(true);
  });

  it("createTransformer accepts tolerateLeadingCode (typed) and returns a transform fn", async () => {
    const { createTransformer } = await import("react-server-loader/transformer");
    const transform = createTransformer({
      options: { moduleBase: "/", tolerateLeadingCode: (s: string) => s.includes("__vitePreload") },
    });
    expect(transform).toBeTypeOf("function");
  });
});
