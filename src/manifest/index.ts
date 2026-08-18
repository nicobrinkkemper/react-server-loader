// Public surface for the reference-manifest emitter — build-time codegen that
// turns enumerated client/server references into a registration artifact with
// static imports, sealing the gate as a closed dictionary (no runtime
// `import()`). See ./emitReferenceManifest.ts for the rationale.
export {
  emitReferenceManifest,
  type ManifestEntry,
} from "./emitReferenceManifest.js";
export {
  createManifestCollector,
  type ManifestCollector,
  type ManifestCollectorOptions,
  type TransformRecord,
} from "./collector.js";
