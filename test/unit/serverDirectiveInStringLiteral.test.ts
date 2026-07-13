import { describe, it, expect, vi } from "vitest";
import { createTransformer } from "../../src/transformer/index.js";
import { DEFAULT_LOADER_CONFIG } from "../../src/transformer/defaults.js";
import { parse } from "../../src/transformer/index.js";
import { hasDirectiveStatement } from "../../src/directives/index.js";

// Regression, the `"use server"` twin of clientDirectiveInStringLiteral.
//
// The transformer AST-verified a possible `"use client"` hit but took a
// `"use server"` hit straight from `findDirectiveMatches` — a regex that matches
// the literal ANYWHERE, including inside strings and comments. So any module
// that merely MENTIONS `"use server"` was transformed as a server-action module:
// every export registered, and an `import { registerServerReference }` injected.
//
// The victim was react-server-dom-esm's own client transport, which throws an
// error whose message reads `Trying to call a function from "use server" but the
// callServer option was not implemented`. That single string made the transform
// inject a `registerServerReference` import into a file that already DEFINES
// `function registerServerReference(...)`, so bundling it died with
// "Identifier `registerServerReference` has already been declared".
//
// It stayed hidden only because the transport was never reachable in a bundle;
// the moment it was, every build that included it broke.

// The real loader config, so the emitted registration carries its real names
// (`registerServerReference`) — which is the whole point of the collision.
const makeOptions = () => ({
  verbose: false,
  loader: DEFAULT_LOADER_CONFIG,
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
});

describe("`use server` inside a string literal", () => {
  it("does not register exports of a module that merely mentions the directive", async () => {
    // Shaped after the real transport: a plain module whose error message quotes
    // `"use server"`, and which happens to define its own registerServerReference.
    const source = `export function callServer() {
  throw new Error(
    'Trying to call a function from "use server" but the callServer option was not implemented.'
  );
}

export function registerServerReference(reference, id, encodeFormAction) {
  return reference;
}`;

    const transformer = createTransformer({
      options: makeOptions(),
      isServerEnvironment: true,
    });

    const result = await transformer(source, "vendor/transport-client.js");

    // The tell-tale of the bug: an injected import colliding with the module's
    // own declaration of the same name.
    expect(result.code).not.toContain(
      'import { registerServerReference } from "react-server-dom-esm/server.node"'
    );
    expect(result.code).not.toMatch(/import\s*{[^}]*registerServerReference/);
  });

  it("does not treat a comment mentioning the directive as one", async () => {
    const source = `// Modules marked "use server" expose their exports as actions.
export const notAnAction = () => 1;`;

    const transformer = createTransformer({
      options: makeOptions(),
      isServerEnvironment: true,
    });

    const result = await transformer(source, "src/notes.js");

    expect(result.code).not.toMatch(/import\s*{[^}]*registerServerReference/);
  });

  it("still registers a real file-level `\"use server\"` module", async () => {
    const source = `"use server";
export async function createTodo(title) {
  return { title };
}`;

    const transformer = createTransformer({
      options: makeOptions(),
      isServerEnvironment: true,
    });

    const result = await transformer(source, "src/actions.js");

    expect(result.code).toContain("registerServerReference");
    expect(result.code).toContain("createTodo");
  });

  it("still registers a real function-level `\"use server\"` action", async () => {
    const source = `export async function createTodo(title) {
  "use server";
  return { title };
}`;

    const transformer = createTransformer({
      options: makeOptions(),
      isServerEnvironment: true,
    });

    const result = await transformer(source, "src/inline-action.js");

    expect(result.code).toContain("registerServerReference");
  });
});

/**
 * The gate must be at least as WIDE as the set the downstream transform can
 * handle, or modules get silently skipped.
 *
 * `directiveInfo.functionLevel` records top-level functions and arrows but NOT
 * class methods or nested declarations, so gating on it dropped those modules —
 * they stopped being transformed at all (no source map, no registration).
 * The gate now looks for a real directive STATEMENT in the prologue of ANY
 * function body, which covers every form without re-admitting quoted literals.
 */
describe("the gate: hasDirectiveStatement", () => {
  const gate = (source: string) =>
    hasDirectiveStatement(parse(source).ast, "use server");

  it.each([
    ["file-level", `"use server";\nexport const x = 1;`],
    ["top-level function", `export async function go(){ "use server"; return 1; }`],
    ["arrow with block body", `export const f = async (x) => { "use server"; return x; };`],
    [
      "class method",
      `export class C { async add(a, b) { "use server"; return a + b; } }`,
    ],
    [
      "object method",
      `export const api = { async save() { "use server"; return 1; } };`,
    ],
    [
      "nested function declaration",
      `export function outer(){ function inner(){ "use server"; return 1; } return inner; }`,
    ],
  ])("sees a real directive in a %s", (_name, source) => {
    expect(gate(source)).toBe(true);
  });

  it.each([
    [
      "string literal",
      `export function e(){ throw new Error('from "use server" here'); }`,
    ],
    ["comment", `// modules marked "use server" expose actions\nexport const x = 1;`],
    [
      "expression position",
      `export const label = "use server";\nexport const x = 1;`,
    ],
    [
      "after real code (not a prologue)",
      `const x = 1;\n"use server";\nexport { x };`,
    ],
  ])("does not see a directive in a %s", (_name, source) => {
    expect(gate(source)).toBe(false);
  });
});
