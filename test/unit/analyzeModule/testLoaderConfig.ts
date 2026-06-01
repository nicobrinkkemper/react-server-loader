import type { DirectiveOptions } from "../../../src/directives/options.js";

export const testLoaderConfig: DirectiveOptions = {
  verbose: false,
  loader: {
    isServerFunctionCode: (code: string) => code.includes("use server"),
    isClientComponentCode: (code: string) => code.includes("use client"),
    getDirectiveType: (directive: string) => {
      if (directive.includes("server")) return "server";
      if (directive.includes("client")) return "client";
      return undefined;
    },
    allowedDirectives: {
      "use server": {
        functionLevel: true,
        target: "server"
      },
      "use client": {
        functionLevel: true,
        target: "client"
      }
    }
  }
}; 