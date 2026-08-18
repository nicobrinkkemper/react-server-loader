// The reference gate: a transport-agnostic allowlist for resolving RSC
// client/server references from a CLIENT-SUPPLIED id.
//
// Why this exists. The vendored `react-server-dom-esm` transport resolves a
// server-action id by parsing `fileURL#export`, checking only that the URL
// starts with a base path, and then `import()`-ing that literal path. The id
// arrives from the client (a server-action POST), so that is an OPEN allowlist:
// any module under the root can be imported and any of its exports invoked,
// whether or not it was ever marked `"use server"`. The bundler transports
// (webpack/parcel) and the official Vite plugin avoid this by resolving against
// a CLOSED, build-time manifest of references — a dictionary lookup that throws
// on an unknown id. This gate is that manifest, authored on our side so it
// works regardless of which transport sits underneath.
//
// The contract is deliberately tiny so any bundler integration can fill it: the
// only input is `(hostedId -> real importer)` pairs. The hosted id is whatever
// the loader's `moduleID` policy emits; the importer is bound to the REAL module
// URL discovered at transform time, NEVER reconstructed from the incoming id.
// The client-supplied id is used ONLY as a dictionary key. An id that was never
// registered cannot resolve, which makes path traversal (`../`) structurally
// impossible rather than something we have to filter for.
//
// Dev vs prod mirrors the official plugin / React themselves: production seals
// the set (strict lookup-or-throw — the real trust boundary); development may
// stay `open` with an on-demand fallback, which is NOT a trust boundary and is
// only ever wired where the server isn't exposed to untrusted clients.

import { NULL_LOGGER, type Logger } from "../directives/options.js";

// The runtime tags React's `register{Server,Client}Reference` stamp onto a
// reference. Resolving an id to a module is not enough — we also confirm the
// named export is an ACTUAL registered reference before handing it back, so a
// registered module can't be used to reach an unmarked export.
const SERVER_REFERENCE_TAG = Symbol.for("react.server.reference");
const CLIENT_REFERENCE_TAG = Symbol.for("react.client.reference");

export type ReferenceKind = "server" | "client";

/** A loaded module — exports keyed by name. */
export type ModuleExports = Record<string, unknown>;

export type ReferenceEntry = {
  /** Hosted id (the loader's `moduleID` output) — the manifest key. */
  id: string;
  /**
   * Importer bound to the REAL module discovered at transform/build time.
   * Never built from the incoming client id. May return the exports
   * synchronously (an emitted manifest binds statically-imported namespaces)
   * or as a promise (`() => import(realUrl)`).
   */
  load: () => ModuleExports | Promise<ModuleExports>;
  kind: ReferenceKind;
  /**
   * Optional per-export allowlist (v2). When present, only these export names
   * resolve for this module — an id naming any other export is rejected even if
   * that export is a real registered reference at runtime. This makes the
   * build-time enumeration the source of truth, narrowing the surface from "any
   * reference export of a registered module" to "exactly the references the
   * build saw". Omit it to allow any reference export (v1 behaviour).
   */
  exportNames?: readonly string[];
};

export type GateMode = "open" | "sealed";

export interface ReferenceGateOptions {
  /**
   * `"sealed"` (production): an unregistered id throws. `"open"` (development):
   * an unregistered id falls back to `devResolve` if provided, else throws.
   * Defaults to `"open"`.
   */
  mode?: GateMode;
  logger?: Logger;
  /**
   * Open-mode only. Resolves a hosted id that was never registered, by
   * importing it on demand against the live module graph. This is the dev
   * convenience that keeps the no-bundler workflow working before a build pass
   * has enumerated everything. It is NOT a security boundary: only wire it in
   * dev. Even then, the named export is still verified to be a real registered
   * reference before use.
   */
  devResolve?: (id: string) => Promise<ModuleExports>;
}

export interface ReferenceGate {
  /** Register a reference. Throws if the gate is already sealed. */
  register(entry: ReferenceEntry): void;
  /** Close the set: registration is rejected and unknown ids always throw. */
  seal(): void;
  /** Resolve a `"use server"` action id to its callable reference. */
  resolveServerReference(id: string): Promise<CallableFunction>;
  /** Resolve a `"use client"` reference id to its client-reference value. */
  resolveClientReference(id: string): Promise<unknown>;
  /** True when `id`'s module key is registered. */
  has(id: string): boolean;
  readonly mode: GateMode;
  readonly sealed: boolean;
  readonly size: number;
}

function isServerReference(value: unknown): value is CallableFunction {
  return (
    typeof value === "function" &&
    (value as { $$typeof?: symbol }).$$typeof === SERVER_REFERENCE_TAG
  );
}

function isClientReference(value: unknown): boolean {
  return (
    !!value &&
    (typeof value === "object" || typeof value === "function") &&
    (value as { $$typeof?: symbol }).$$typeof === CLIENT_REFERENCE_TAG
  );
}

// A reference id is `<hostedModuleId>#<exportName>`. Export names never contain
// `#`, and a hosted id (a path/URL) may, so split on the LAST `#`.
function splitReferenceId(id: string): { key: string; name: string } {
  const idx = id.lastIndexOf("#");
  if (idx <= 0 || idx === id.length - 1) {
    throw new Error(
      `Invalid reference id ${JSON.stringify(id)}: expected "<moduleId>#<exportName>".`,
    );
  }
  return { key: id.slice(0, idx), name: id.slice(idx + 1) };
}

/**
 * Build a reference gate. Populate it with {@link ReferenceGate.register} (from
 * a build pass or the loader's `onTransform` hook), {@link ReferenceGate.seal}
 * it in production, then resolve incoming ids through
 * {@link ReferenceGate.resolveServerReference} /
 * {@link ReferenceGate.resolveClientReference} instead of importing the id's
 * path directly.
 */
export function createReferenceGate(
  options: ReferenceGateOptions = {},
): ReferenceGate {
  const mode = options.mode ?? "open";
  const logger = options.logger ?? NULL_LOGGER;
  const devResolve = options.devResolve;
  const registry = new Map<string, ReferenceEntry>();
  let sealed = false;

  async function load(
    id: string,
    expected: ReferenceKind,
  ): Promise<ModuleExports> {
    const { key, name } = splitReferenceId(id);
    const entry = registry.get(key);
    if (entry) {
      if (entry.kind !== expected) {
        throw new Error(
          `Reference ${JSON.stringify(id)} is registered as a ${entry.kind} reference, not ${expected}.`,
        );
      }
      if (entry.exportNames && !entry.exportNames.includes(name)) {
        throw new Error(
          `Export ${JSON.stringify(name)} of ${JSON.stringify(key)} is not in the reference allowlist.`,
        );
      }
      return entry.load();
    }
    // Unknown id. Sealed = the trust boundary: reject. Open = dev convenience.
    // `sealed` covers an open-mode gate after seal() — once sealed, devResolve
    // must never run, or seal() would not close the set it claims to close.
    if (sealed || mode === "sealed" || !devResolve) {
      throw new Error(`Unknown ${expected} reference: ${JSON.stringify(key)}`);
    }
    logger.warn(
      `[reference-gate] ${expected} reference ${JSON.stringify(key)} not registered; resolving on demand (dev only, not a trust boundary)`,
    );
    return devResolve(key);
  }

  return {
    mode,
    get sealed() {
      return sealed;
    },
    get size() {
      return registry.size;
    },
    register(entry) {
      if (sealed) {
        throw new Error(
          `Cannot register ${JSON.stringify(entry.id)}: the reference gate is sealed.`,
        );
      }
      registry.set(entry.id, entry);
    },
    seal() {
      sealed = true;
    },
    has(id) {
      const idx = id.lastIndexOf("#");
      return registry.has(idx > 0 ? id.slice(0, idx) : id);
    },
    async resolveServerReference(id) {
      const { name } = splitReferenceId(id);
      const mod = await load(id, "server");
      const ref = mod[name];
      if (!isServerReference(ref)) {
        throw new Error(
          `Export ${JSON.stringify(name)} of ${JSON.stringify(id)} is not a registered server reference.`,
        );
      }
      return ref;
    },
    async resolveClientReference(id) {
      const { name } = splitReferenceId(id);
      const mod = await load(id, "client");
      const ref = mod[name];
      if (!isClientReference(ref)) {
        throw new Error(
          `Export ${JSON.stringify(name)} of ${JSON.stringify(id)} is not a registered client reference.`,
        );
      }
      return ref;
    },
  };
}
