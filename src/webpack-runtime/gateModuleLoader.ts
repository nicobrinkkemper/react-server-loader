// Adapter: back webpack's async chunk loading with the sealed reference gate.
//
// This is the ACTION path (`decodeReply` + `serverModuleMap`): the ids being
// loaded arrive from the client, so they must resolve through the closed,
// tag-verified allowlist — never an open import. Wire it as the `load` option
// of `installWebpackGlobals`, and list each server reference's full
// `moduleId#export` id in its metadata `chunks` so the gate resolves during
// React's preload (the async window) and the sync require hits the cache.
//
// Deliberately server-references-only. SSR loading of CLIENT components takes
// the REAL baked component modules (plain functions, no reference tags), which
// the gate's tag verification would rightly reject — feed those to
// `installWebpackGlobals` as a static `modules` registry instead.
import type { ReferenceGate } from "../references/gate.js";
import type { ModuleExports } from "./installWebpackGlobals.js";

export function gateModuleLoader(
  gate: Pick<ReferenceGate, "resolveServerReference">
): (chunkId: string) => Promise<ModuleExports> {
  return async (chunkId: string): Promise<ModuleExports> => {
    const hash = chunkId.indexOf("#");
    if (hash === -1) {
      throw new Error(
        `gateModuleLoader: chunk id "${chunkId}" has no "#<export>" part. ` +
          "Gate-backed loading resolves per export — list the reference's full " +
          "`moduleId#export` id in its metadata chunks."
      );
    }
    const exportName = chunkId.slice(hash + 1);
    const reference = await gate.resolveServerReference(chunkId);
    return { [exportName]: reference };
  };
}
