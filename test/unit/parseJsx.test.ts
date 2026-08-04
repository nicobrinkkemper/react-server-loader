import { describe, it, expect, vi } from "vitest";
import { createTransformer, parse } from "../../src/transformer/index.js";
import { DEFAULT_LOADER_CONFIG } from "../../src/transformer/defaults.js";

// parse() is JSX-capable on purpose. Untranspiled component sources reach the
// analysis paths that use rsl's own parser (not the bundler's), and a parse
// throw drops directive detection to the transformer's fallback — where the
// server side is a bare regex that matches `"use server"` anywhere in the
// text, including JSX text and string literals. With JSX parsing the
// detection stays structural and the fallback stays rare.

const makeOptions = () => ({
  verbose: false,
  loader: DEFAULT_LOADER_CONFIG,
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
});

describe("JSX-capable parse", () => {
  it("parses an untranspiled JSX component", () => {
    const { ast } = parse(`"use client";
export function Button({ onClick }) {
  return <button onClick={onClick}>Save</button>;
}`);
    expect(ast.body[0].type).toBe("ExpressionStatement");
  });

  it("does not server-transform a JSX module that only mentions the directive", async () => {
    // Pre-JSX parsing this source THREW in parse(), and the fallback's raw
    // regex hit the `"use server"` in the JSX text — transforming a plain
    // component into a server-action module.
    const source = `export function Docs() {
  return <p>Mark a module with "use server" to expose its exports.</p>;
}`;

    const transformer = createTransformer({
      options: makeOptions(),
      isServerEnvironment: true,
    });

    const result = await transformer(source, "src/components/Docs.jsx");

    expect(result.code).not.toMatch(/registerServerReference/);
  });

  it("still registers a real file-level 'use server' JSX module", async () => {
    const source = `"use server";
export async function addItem(title) {
  return { ok: !!title };
}`;

    const transformer = createTransformer({
      options: makeOptions(),
      isServerEnvironment: true,
    });

    const result = await transformer(source, "src/actions/items.js");

    expect(result.code).toMatch(/registerServerReference/);
  });
});
