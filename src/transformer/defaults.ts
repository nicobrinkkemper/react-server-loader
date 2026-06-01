// Default configuration for the React Server Components contract.
//
// These values match what React publishes in `react-server-dom-esm`: a
// server bundle exports `registerClientReference` and
// `registerServerReference`, the default transport entry points are
// `react-server-dom-esm/server`, and the recognised file-level
// directives are `"use client"` and `"use server"`. The transformer
// primitives reach for this object when a caller doesn't pass an
// explicit `loader` option.
//
// Override any field via the `loader` option when integrating with a
// different transport (Webpack, Parcel, etc.) or when running under
// React's `react-server-dom-esm/server.node` test-mode build. The
// `DEFAULT_CONFIG.RSC_LOADER` map keys each `NODE_ENV` against the
// appropriate default — production and development share the same entry
// points, while test mode resolves explicitly to `.node` to match
// React's own internal test wiring.

import { parse } from "./parse.js";
import {
  defaultGetDirectiveType,
  CONSOLE_LOGGER,
} from "../directives/options.js";
import { detectClientModule } from "../directives/detectClientModule.js";
import { getNodeEnv, type NodeEnv } from "../runtime/env.js";

const DIRECTIVE_PATTERNS = {
  CLIENT: /^\s*(?:"use client"|'use client')\s*(?:\n|;|$)/,
  SERVER: /(?:"use server"|'use server')\s*(?:\n|;|$)/,
  ANY: /(?:"use\s+(?:client|server)"|'use\s+(?:client|server)')\s*(?:\n|;|$)/g,
} as const;

const SERVER_ACTION_FILE = /(\.|\/)?server(\.|\/)?/;
const IS_SERVER_ACTION_CODE = (code: string, moduleId?: string) =>
  code.match(SERVER_ACTION_FILE) != null ||
  (moduleId && SERVER_ACTION_FILE.test(moduleId.toLowerCase())) ||
  false;

const IS_CLIENT_COMPONENT_CODE = (code: string, moduleId?: string) =>
  detectClientModule({ source: code, moduleId });

const IS_CLIENT_COMPONENT_BY_CODE = (code: string) =>
  detectClientModule({ source: code });

const IS_CLIENT_COMPONENT_BY_NAME = (
  moduleId: string,
  _transformedModuleId?: string,
) => detectClientModule({ moduleId });

export const DIRECTIVE_CONFIGS = {
  client: {
    functionLevel: false,
    target: "client" as const,
    validate: (params: { index: number }) => params.index === 0,
    warning: "'use client' directive is only allowed at the top of a file",
  },
  server: {
    functionLevel: true,
    target: "server" as const,
    validate: (params: { code: string; index: number }) => {
      const before = params.code.slice(0, params.index).trim();
      return before === "" || before.endsWith("\n");
    },
    warning:
      "File-level directives must be at the top of the file, before any other code",
  },
} as const;

export const DEFAULT_LOADER_CONFIG = {
  serverDirective: DIRECTIVE_PATTERNS.SERVER,
  clientDirective: DIRECTIVE_PATTERNS.CLIENT,
  directivePattern: DIRECTIVE_PATTERNS.ANY,
  isServerFunctionCode: IS_SERVER_ACTION_CODE,
  isClientComponentCode: IS_CLIENT_COMPONENT_CODE,
  isClientComponentByCode: IS_CLIENT_COMPONENT_BY_CODE,
  isClientComponentByName: IS_CLIENT_COMPONENT_BY_NAME,
  allowedDirectives: DIRECTIVE_CONFIGS,
  importServerPath: "react-server-dom-esm/server",
  importClientPath: "react-server-dom-esm/server",
  registerClientReferenceName: "registerClientReference",
  registerServerReferenceName: "registerServerReference",
  getDirectiveType: defaultGetDirectiveType,
  parse,
  mode: getNodeEnv(),
  verbose: false,
  logger: CONSOLE_LOGGER,
  moduleID: (moduleId: string, _sourceContent?: string) =>
    typeof moduleId === "string" ? moduleId : String(moduleId),
} as const;

export const DEFAULT_CONFIG = {
  RSC_LOADER: {
    development: {
      ...DEFAULT_LOADER_CONFIG,
      mode: "development" as const,
    },
    test: {
      ...DEFAULT_LOADER_CONFIG,
      importServerPath: "react-server-dom-esm/server.node",
      importClientPath: "react-server-dom-esm/server.node",
      mode: "test" as const,
    },
    production: {
      ...DEFAULT_LOADER_CONFIG,
      mode: "production" as const,
    },
  } satisfies Record<NodeEnv, unknown>,
} as const;
