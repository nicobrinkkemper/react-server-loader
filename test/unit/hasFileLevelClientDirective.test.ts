import { describe, it, expect } from "vitest";
import { hasFileLevelClientDirective } from "../../src/directives/hasFileLevelClientDirective.js";

// Unit coverage for the file-level "use client" detector. Moved here from
// vite-plugin-react-server along with the implementation when vprs became a
// thin adapter over rsl.
describe("hasFileLevelClientDirective (acorn-parseable sources)", () => {
  it("detects a top-of-file 'use client' directive", () => {
    expect(hasFileLevelClientDirective(`"use client";\nexport const x = 1;`)).toBe(
      true
    );
  });

  it("tolerates a leading 'use strict' prologue", () => {
    expect(
      hasFileLevelClientDirective(
        `"use strict";\n"use client";\nexport const x = 1;`
      )
    ).toBe(true);
  });

  it("does not flag a plain server module", () => {
    expect(
      hasFileLevelClientDirective(
        `import React from "react";\nexport function Page(){ return null; }`
      )
    ).toBe(false);
  });

  it("does NOT flag the substring 'client' in an import path (robust, not naive)", () => {
    expect(
      hasFileLevelClientDirective(
        `import { createClient } from "./client/foo.js";\nexport const x = 1;`
      )
    ).toBe(false);
  });

  it("does not flag a mid-file / function-level directive as file-level", () => {
    expect(
      hasFileLevelClientDirective(`const a = 1;\n"use client";\nexport const x = 1;`)
    ).toBe(false);
  });

  it("returns false for empty/undefined input", () => {
    expect(hasFileLevelClientDirective(undefined)).toBe(false);
    expect(hasFileLevelClientDirective("")).toBe(false);
  });
});
