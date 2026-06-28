import { describe, it, expect, vi } from "vitest";
import { createTransformer } from "../../src/transformer/index.js";
import { testLoaderConfig } from "./analyzeModule/testLoaderConfig.js";

// Regression: a *server* component that merely DISPLAYS `"use client"` example
// code (the literal appears inside a string/template/JSX text, not as a
// top-of-file directive) must NOT be transformed into a client module.
//
// The transformer's directive fast-path used to ask `findDirectiveMatches`
// (a regex matching the literal `"use client"` ANYWHERE) whether the file had a
// client directive. A docs/landing component rendering a code snippet that
// contains `"use client"` tripped that regex, so the server component was
// emitted with `registerClientReference` and then panicked at render with
// "Attempted to load a Client Module outside the hosted root."
//
// The client decision now goes through the top-of-file scanner, which only
// recognises a real file-level directive.

const makeOptions = () => ({
  ...testLoaderConfig,
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
});

describe("`use client` inside a string literal", () => {
  it("does not turn a server component into a client reference", async () => {
    // A server component (no top-of-file directive) showing client-code example.
    const source = `const clientCode = \`// Counter.tsx
"use client"

import { useState } from "react"

export function Counter() {
  return null
}\`;

export function CodeExamples() {
  return clientCode;
}`;

    const transformer = createTransformer({
      options: makeOptions(),
      isServerEnvironment: true,
    });

    const result = await transformer(source, "src/CodeExamples.js");

    // A client module gets its exports replaced by a throwing stub; a server
    // component is returned as-is. The literal must not flip it to client.
    expect(result.code).not.toContain("Attempted to call");
  });

  it("still treats a real top-of-file directive as a client module", async () => {
    const source = `"use client";
import { useState } from "react";
export function Counter() {
  const [n, setN] = useState(0);
  return n;
}`;

    const transformer = createTransformer({
      options: makeOptions(),
      isServerEnvironment: true,
    });

    const result = await transformer(source, "src/Counter.js");

    // Real directive → exports replaced by the client-reference stub.
    expect(result.code).toContain("Attempted to call");
  });
});
