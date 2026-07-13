import { describe, it, expect } from "vitest";
import { parse } from "acorn";
import type { Program } from "acorn";
import {
  detectClientModule,
  looksLikeClientFilename,
} from "../../src/directives/index.js";

/**
 * Unit suite for the client-module detector.
 *
 * Pins the four classes of "is this client?" answers that have to stay
 * stable regardless of which call site asks:
 *   - directive-only modules without the `.client.` filename suffix are
 *     recognised,
 *   - a `"use strict"` or comment prologue above `"use client"` is
 *     tolerated,
 *   - substring matches against "client" (identifiers, comments, import
 *     paths, directory names) do NOT classify a module as client,
 *   - the AST path and the parser-free scanner path agree on every input.
 */

const acornParse = (src: string): Program =>
  parse(src, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowReturnOutsideFunction: true,
  }) as unknown as Program;

describe("detectClientModule (unified client-module detector)", () => {
  /**
   * The filename is NOT a classifier. Only `"use client"` makes a client
   * module — the one signal React defines and the only one that survives a move
   * to another toolchain. A name-classified file would work here and silently
   * become a server module everywhere else.
   */
  describe("filename never classifies (no source)", () => {
    it.each([
      // Dotted suffix convention.
      "components/Counter.client.tsx",
      "components/Counter.client.ts",
      "components/Counter.client.js",
      "components/Counter.client.mjs",
      // Standalone-basename convention — the app client-entry filename.
      "client.tsx",
      "src/client.tsx",
      "src/client.js",
      // Package paths.
      "node_modules/vite-plugin-react-server/dist/plugin/stream/index.client.js",
      "node_modules/some-lib/client.js",
      // Never-client names.
      "components/Counter.tsx",
      "src/lib/clientId.ts",
      "src/client/foo.ts",
    ])("does not classify %s without a directive", (moduleId) => {
      expect(detectClientModule({ moduleId })).toBe(false);
    });

    it("does not classify a `.client.tsx` even when source is present but undirected", () => {
      expect(
        detectClientModule({
          moduleId: "components/Counter.client.tsx",
          source: `export const Counter = () => null;`,
        }),
      ).toBe(false);
    });
  });

  describe("looksLikeClientFilename (warning signal, not a classifier)", () => {
    it.each([
      "components/Counter.client.tsx",
      "src/client.tsx",
      "client.tsx",
    ])("flags first-party %s for a warning", (moduleId) => {
      expect(looksLikeClientFilename(moduleId)).toBe(true);
    });

    it.each([
      // A dependency's layout is its own business — `.client` there routinely
      // means a build-condition variant, not `"use client"`.
      "node_modules/vite-plugin-react-server/dist/plugin/stream/index.client.js",
      "/abs/node_modules/some-lib/client.js",
      // Substrings must not trip it.
      "src/lib/clientId.ts",
      "src/client/foo.ts",
      "components/Counter.tsx",
    ])("does not flag %s", (moduleId) => {
      expect(looksLikeClientFilename(moduleId)).toBe(false);
    });
  });

  describe("source-only directive (no parser, scanner path)", () => {
    it("detects a top-of-file `\"use client\"`", () => {
      expect(
        detectClientModule({
          source: `"use client";\nexport const x = 1;`,
        }),
      ).toBe(true);
    });

    it("tolerates a `\"use strict\"` prologue above `\"use client\"`", () => {
      expect(
        detectClientModule({
          source: `"use strict";\n"use client";\nexport const x = 1;`,
        }),
      ).toBe(true);
    });

    it("tolerates a leading block-comment header (JSDoc) above `\"use client\"`", () => {
      expect(
        detectClientModule({
          source: `/**\n * @license MIT\n */\n"use client";\nexport const x = 1;`,
        }),
      ).toBe(true);
    });

    it("tolerates a leading line comment above `\"use client\"`", () => {
      expect(
        detectClientModule({
          source: `// auto-generated\n"use client";\nexport const x = 1;`,
        }),
      ).toBe(true);
    });

    it("rejects a `\"use client\"` placed after a real statement", () => {
      expect(
        detectClientModule({
          source: `const x = 1;\n"use client";\nexport { x };`,
        }),
      ).toBe(false);
    });

    it("rejects a comment that merely contains the word `use client`", () => {
      expect(
        detectClientModule({
          source: `// not a use client directive\nexport const x = 1;`,
        }),
      ).toBe(false);
    });

    it("rejects an identifier named `clientId` with no real directive", () => {
      expect(
        detectClientModule({
          source: `const clientId = "x";\nexport { clientId };`,
        }),
      ).toBe(false);
    });

    it("rejects an import path mentioning `client`", () => {
      expect(
        detectClientModule({
          source: `import { foo } from "./client/foo";\nexport const y = foo;`,
        }),
      ).toBe(false);
    });

    it("does not flag a server module under default settings", () => {
      expect(
        detectClientModule({
          source: `import React from "react";\nexport function Page(){ return null; }`,
        }),
      ).toBe(false);
    });
  });

  describe("source + parser (AST path, build-time transformer)", () => {
    it("detects `\"use client\"` via the AST path", () => {
      expect(
        detectClientModule({
          source: `"use client";\nexport const x = 1;`,
          parseFn: acornParse,
        }),
      ).toBe(true);
    });

    it("tolerates a `\"use strict\"` prologue via the AST path", () => {
      expect(
        detectClientModule({
          source: `"use strict";\n"use client";\nexport const x = 1;`,
          parseFn: acornParse,
        }),
      ).toBe(true);
    });

    it("rejects a misplaced `\"use client\"` after a statement via the AST path", () => {
      expect(
        detectClientModule({
          source: `const x = 1;\n"use client";\nexport { x };`,
          parseFn: acornParse,
        }),
      ).toBe(false);
    });

    it("falls back to the scanner when the parser throws", () => {
      // Throw on every call → triggers fallback to char-scanner.
      const throwingParse = (): Program => {
        throw new Error("parse failure");
      };
      expect(
        detectClientModule({
          source: `"use client";\nexport const x = 1;`,
          parseFn: throwingParse,
        }),
      ).toBe(true);
    });
  });

  describe("filename + source combined", () => {
    it("returns false when the filename matches but the source has no directive", () => {
      expect(
        detectClientModule({
          moduleId: "components/Counter.client.tsx",
          source: `export const x = 1;`,
        }),
      ).toBe(false);
    });

    it("returns true when a `.client.` file DOES carry the directive", () => {
      expect(
        detectClientModule({
          moduleId: "components/Counter.client.tsx",
          source: `"use client";\nexport const x = 1;`,
        }),
      ).toBe(true);
    });

    it("returns true when source has directive even without `.client.` filename", () => {
      expect(
        detectClientModule({
          moduleId: "components/Counter.tsx",
          source: `"use client";\nexport const x = 1;`,
        }),
      ).toBe(true);
    });

    it("returns false when neither filename nor source qualifies", () => {
      expect(
        detectClientModule({
          moduleId: "components/Counter.tsx",
          source: `export const x = 1;`,
        }),
      ).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("returns false for empty source and no moduleId", () => {
      expect(detectClientModule({})).toBe(false);
    });

    it("returns false for empty source string", () => {
      expect(detectClientModule({ source: "" })).toBe(false);
    });

    it("does not invoke parser when source lacks `use client` substring", () => {
      // If parseFn is called and throws, we'd see the error. Cheap pre-filter
      // gates it.
      const exploding = (): Program => {
        throw new Error("parser should not have been called");
      };
      expect(
        detectClientModule({
          source: `export const x = 1;`,
          parseFn: exploding,
        }),
      ).toBe(false);
    });
  });

  /**
   * The concrete regression: vite-plugin-react-server ships
   * `stream/index.client.js` — server-side stream infrastructure
   * (`createEdgeHandler`, `renderFlightToHtml`) whose `.client` suffix names a
   * build-CONDITION variant, not a `"use client"` component. Classifying it by
   * name replaced every export with a throw-on-call client reference inside a
   * consumer's server build, breaking the production server that imports
   * `createEdgeHandler` from exactly that module.
   */
  describe("packages are classified by directive alone", () => {
    it("does not classify vprs's condition-variant stream barrel", () => {
      expect(
        detectClientModule({
          moduleId:
            "node_modules/vite-plugin-react-server/dist/plugin/stream/index.client.js",
          source: `export const createEdgeHandler = () => {};`,
        }),
      ).toBe(false);
    });

    it("still honours an explicit `\"use client\"` directive inside a package", () => {
      expect(
        detectClientModule({
          moduleId:
            "node_modules/vite-plugin-react-server/dist/plugin/router/link.js",
          source: `"use client";\nexport const Link = () => null;`,
        }),
      ).toBe(true);
    });
  });
});
