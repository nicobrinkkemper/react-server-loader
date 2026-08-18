import type { ReferenceKind } from "../references/index.js";
import type { ManifestEntry } from "./emitReferenceManifest.js";

/** One transform outcome, as the loader's transform path knows it. */
export type TransformRecord = {
  /** The real module id the transform saw (source path/URL). */
  moduleId: string;
  /** The hosted id it registered under (the `moduleID` output) — the gate key. */
  transformedModuleId: string;
  kind: ReferenceKind;
  exportNames: readonly string[];
};

export type ManifestCollector = {
  /**
   * Feed one transform's outcome. A later record for the same hosted id
   * replaces the earlier one (re-transforms are idempotent).
   */
  onTransform(record: TransformRecord): void;
  /** Snapshot the collected records as emitter entries. */
  entries(): ManifestEntry[];
};

export interface ManifestCollectorOptions {
  /**
   * Maps a record to the import specifier the emitted artifact should use for
   * the real module — typically the record's `moduleId` rewritten relative to
   * wherever the consumer writes the artifact. Defaults to `moduleId` as-is.
   */
  specifier?: (record: TransformRecord) => string;
}

/**
 * Convenience producer for {@link emitReferenceManifest}: accumulate records
 * from the transform path (where module id, hosted id, kind and export names
 * are all known) and snapshot them as manifest entries. A bundler that already
 * holds its own reference manifest can skip this and build entries directly —
 * both are producers for the one emitter.
 */
export function createManifestCollector(
  options: ManifestCollectorOptions = {},
): ManifestCollector {
  const specifier = options.specifier ?? ((record) => record.moduleId);
  const records = new Map<string, TransformRecord>();
  return {
    onTransform(record) {
      records.set(record.transformedModuleId, record);
    },
    entries() {
      return Array.from(records.values(), (record) => ({
        id: record.transformedModuleId,
        specifier: specifier(record),
        kind: record.kind,
        exportNames: record.exportNames,
      }));
    },
  };
}
