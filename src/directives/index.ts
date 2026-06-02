// Public surface (see docs/api-reference.md). The AST type-guards, the
// per-node analysis helpers (analyzeDirectives, findDirectiveMatches,
// collectExports, getExports, getFunctionBody/Name, getQualifiedName,
// processFunctionNode, addLocalExportedNames, hasFileLevelClientDirective)
// and utils are internal — used by analyzeModule, not part of the API.
export { detectClientModule } from "./detectClientModule.js";
export { sourceHasTopLevelClientDirective } from "./sourceHasTopLevelClientDirective.js";
export { analyzeModule } from "./analyzeModule.js";

// Public types consumers and frameworks build against.
export type * from "./types.js";
export type { DirectiveOptions } from "./options.js";
