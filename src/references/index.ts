// Public surface for the reference gate — the manifest-backed allowlist that
// closes the open client/server reference resolution in the vendored transport.
// See ./gate.ts for the rationale.
export {
  createReferenceGate,
  type ReferenceGate,
  type ReferenceGateOptions,
  type ReferenceEntry,
  type ReferenceKind,
  type GateMode,
  type ModuleExports,
} from "./gate.js";
