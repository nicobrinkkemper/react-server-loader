import { analyzeModule } from "../../../src/directives/analyzeModule.js";
import { describe, test, expect } from "vitest";
import { testLoaderConfig } from "./testLoaderConfig.js";

describe("analyzeModule - file-level directive warnings", () => {
  test("should warn about multiple file-level directives", async () => {
    const result = await analyzeModule(
      `"use client";
"use server";
export function test() {
  return 42;
}`,
      testLoaderConfig
    );
    expect(result.directiveInfo?.warnings).toHaveLength(1);
  });

  test("should warn about mixed server/client file-level directives", async () => {
    const result = await analyzeModule(
      `"use client";
"use server";
export function test() {
  return 42;
}`,
      testLoaderConfig
    );
    expect(result.directiveInfo?.warnings).toHaveLength(1);
  });

  test("should warn about file-level directive after code", async () => {
    const result = await analyzeModule(
      `const x = 1;\n"use server";\nexport function test() { return x; }`,
      testLoaderConfig
    );
    expect(result.directiveInfo?.fileLevel?.type).toBe("server");
    expect(result.directiveInfo?.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("must be at the top of the file"),
          type: "server"
        })
      ])
    );
  });

  // Comments are trivia, not code: a directive after nothing but comments is
  // a valid directive prologue. Compiled library output routinely ships
  // banner/JSDoc comments above "use client" (tsup/rollup banners), and the
  // worker loader path must classify those identically to the build side.
  test("should NOT warn about file-level directive after comments only", async () => {
    const result = await analyzeModule(
      `// Some comment
/* Another comment */
"use client";
export function test() {
  return 42;
}`,
      testLoaderConfig
    );
    expect(result.directiveInfo?.fileLevel?.type).toBe("client");
    expect(result.directiveInfo?.warnings).toEqual([]);
  });

  test("should accept a JSDoc block before 'use client' without warnings", async () => {
    const result = await analyzeModule(
      `/**
 * A widget library.
 * @license MIT
 */
"use client";
export function Widget() {
  return null;
}`,
      testLoaderConfig
    );
    expect(result.directiveInfo?.fileLevel?.type).toBe("client");
    expect(result.directiveInfo?.warnings).toEqual([]);
  });

  test("should accept use-strict + JSDoc + use-client together (compiled node_modules shape)", async () => {
    const result = await analyzeModule(
      `"use strict";
/**
 * compiled by tsup
 */
"use client";
export function Button() {
  return null;
}`,
      testLoaderConfig
    );
    expect(result.directiveInfo?.fileLevel?.type).toBe("client");
    expect(result.directiveInfo?.warnings).toEqual([]);
  });

  test("should still warn when CODE precedes the directive even with comments around it", async () => {
    const result = await analyzeModule(
      `// banner
const x = 1;
"use client";
export function test() { return x; }`,
      testLoaderConfig
    );
    expect(
      result.directiveInfo?.warnings.some((w) =>
        w.message.includes("must be at the top of the file")
      )
    ).toBe(true);
  });

  // Real-world libraries (e.g. compiled output of @chakra-ui/react,
  // @ark-ui/react) ship files that begin with `"use strict"; "use client";`
  // simultaneously. The analyzer must accept this without warnings: the JS
  // prologue directive ("use strict") and the React directive ("use client")
  // are orthogonal and frequently coexist.
  test("should accept 'use strict' followed by 'use client' without warnings", async () => {
    const result = await analyzeModule(
      `"use strict";
"use client";
export function test() {
  return 42;
}`,
      testLoaderConfig
    );
    expect(result.directiveInfo?.fileLevel?.type).toBe("client");
    expect(result.directiveInfo?.warnings).toEqual([]);
  });

  test("should accept 'use strict' followed by 'use server' without warnings", async () => {
    const result = await analyzeModule(
      `"use strict";
"use server";
export async function action() {
  return 42;
}`,
      testLoaderConfig
    );
    expect(result.directiveInfo?.fileLevel?.type).toBe("server");
    expect(result.directiveInfo?.warnings).toEqual([]);
  });

  test("should still warn when both 'use client' and 'use server' coexist after 'use strict'", async () => {
    const result = await analyzeModule(
      `"use strict";
"use client";
"use server";
export function test() {
  return 42;
}`,
      testLoaderConfig
    );
    // 'use strict' is benign; the conflict is between 'use client' (file-level)
    // and the trailing 'use server'.
    expect(result.directiveInfo?.fileLevel?.type).toBe("client");
    expect(
      result.directiveInfo?.warnings.some((w) =>
        w.message.includes("Cannot have both")
      )
    ).toBe(true);
  });
}); 