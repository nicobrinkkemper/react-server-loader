import type { Program } from "acorn";

/**
 * Does the module contain a REAL `directive` prologue statement anywhere?
 *
 * "Anywhere" is the point. A `"use server"` directive is legal at the top of the
 * module *or* at the top of any function body — including forms the directive
 * engine's `functionLevel` list does not record (class methods, object methods,
 * nested function declarations). The transformer needs a gate that says "this
 * module has server directives worth transforming", and that gate must be at
 * least as wide as the set the downstream transform can handle, or modules get
 * silently skipped.
 *
 * It must NOT be a text search. `findDirectiveMatches` regexes the literal
 * anywhere, so a module that merely quotes `"use server"` inside a string or a
 * comment trips it — which is how react-server-dom-esm's own transport (whose
 * error message quotes the directive) ended up being transformed as a
 * server-action module.
 *
 * A directive is an ExpressionStatement holding a plain string literal, in the
 * PROLOGUE — the leading run of such statements — of a Program or a function
 * body. Anything after the first non-string statement is ordinary code, and a
 * string in an expression position is just a string. That distinction is what
 * this walk encodes, and it is why the gate can be wide without being wrong.
 */

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

type AnyNode = Record<string, unknown> & { type?: string };

/** The string value of a directive-shaped statement, or null if it isn't one. */
function directiveValue(stmt: unknown): string | null {
  const node = stmt as AnyNode | null;
  if (!node || node.type !== "ExpressionStatement") return null;
  // Acorn/ESTree annotate prologue statements with `directive`; parsers that
  // don't (some Oxc builds) still give us the literal, so check both.
  if (typeof node.directive === "string") return node.directive;
  const expr = node.expression as AnyNode | undefined;
  if (expr?.type === "Literal" && typeof expr.value === "string") {
    return expr.value;
  }
  return null;
}

/** Scan a prologue: the leading run of string-literal statements, and no further. */
function prologueHas(body: unknown, directive: string): boolean {
  if (!Array.isArray(body)) return false;
  for (const stmt of body) {
    const value = directiveValue(stmt);
    if (value === null) return false; // prologue over — the rest is code
    if (value === directive) return true;
  }
  return false;
}

export function hasDirectiveStatement(
  ast: Program | undefined,
  directive: string
): boolean {
  if (!ast) return false;
  let found = false;

  const visit = (node: unknown): void => {
    if (found || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const n = node as AnyNode;

    if (n.type === "Program" && prologueHas(n.body, directive)) {
      found = true;
      return;
    }
    if (FUNCTION_TYPES.has(n.type ?? "")) {
      const body = n.body as AnyNode | undefined;
      // A concise arrow body (`() => x`) is an expression, not a block, so it
      // has no prologue and cannot carry a directive.
      if (body?.type === "BlockStatement" && prologueHas(body.body, directive)) {
        found = true;
        return;
      }
    }

    for (const key in n) {
      if (key === "type" || key === "loc" || key === "range") continue;
      visit(n[key]);
      if (found) return;
    }
  };

  visit(ast);
  return found;
}
