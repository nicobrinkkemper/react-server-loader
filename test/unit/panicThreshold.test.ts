import { describe, it, expect, vi } from "vitest";
import { createTransformer } from "../../src/transformer/index.js";
import { testLoaderConfig } from "./analyzeModule/testLoaderConfig.js";

// Covers createTransformer's panicThreshold downgrade. rsl already tests that
// analyzeModule *emits* the misplaced-directive warning (see
// analyzeModule/fileLevelWarnings.test.ts); this pins the transformer's
// behaviour when that warning is encountered: with panicThreshold "none" (in a
// non-production env) it must downgrade to a logger.warn instead of throwing.
// This coverage moved from vite-plugin-react-server, where it spied on
// console.warn; warnings now flow through the injectable logger.

// A misplaced file-level directive (real code precedes it) — the canonical
// trigger for the "must be at the top of the file" warning.
const sourceWithWarning = `const x = 1;
"use server";
export async function action() {
  return 42;
}`;

const makeOptions = (logger: unknown) => ({
  ...testLoaderConfig,
  panicThreshold: "none" as const,
  logger,
});

describe("panicThreshold downgrade", () => {
  it("downgrades a directive error to a logger warning when panicThreshold='none'", async () => {
    const warn = vi.fn();
    const logger = { info: vi.fn(), debug: vi.fn(), warn, error: vi.fn() };

    const transformer = createTransformer({
      options: makeOptions(logger),
      isServerEnvironment: true,
    });

    // Must not throw, and must return a transformed result.
    const result = await transformer(sourceWithWarning, "test.js");
    expect(result).toBeDefined();
    expect(result.code).toBeDefined();

    // The directive error is surfaced as a warning, not thrown.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("must be at the top of the file")
    );
  });

  it("includes a source-context preview when downgrading", async () => {
    const warn = vi.fn();
    const logger = { info: vi.fn(), debug: vi.fn(), warn, error: vi.fn() };

    const transformer = createTransformer({
      options: makeOptions(logger),
      isServerEnvironment: true,
    });

    await transformer(sourceWithWarning, "test.js");

    // The downgrade path prints the offending line(s) as context, so warn is
    // called more than once (the message plus the numbered source preview).
    expect(warn.mock.calls.length).toBeGreaterThan(1);
    const allOutput = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(allOutput).toContain("use server");
  });
});
