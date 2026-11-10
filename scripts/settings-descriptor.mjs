/**
 * A plain-data description of a zod schema, for the admin settings form. The
 * form walks this tree instead of the schema, so the admin bundle does not
 * carry zod. Only the facts the form needs are kept: the kind of each setting,
 * whether it may be left out, its default, enum options and nested shapes.
 *
 * It reads zod's `_def.typeName` and calls `isOptional()`, so it needs no zod
 * import. `pnpm gen:settings` writes the result to src/admin/settings-descriptor.json
 * and test/settings-descriptor.test.ts fails when that file is stale.
 */
export function describeSchema(schema) {
  const typeName = (s) => s._def.typeName;
  function inner(s) {
    switch (typeName(s)) {
      case "ZodEffects": return inner(s._def.schema);
      case "ZodDefault": return inner(s._def.innerType);
      case "ZodOptional": case "ZodNullable": return inner(s._def.innerType);
      default: return s;
    }
  }
  function walk(s) {
    const t = inner(s);
    const node = {};
    switch (typeName(t)) {
      case "ZodObject": node.k = "object"; node.shape = Object.fromEntries(Object.entries(t.shape).map(([key, value]) => [key, walk(value)])); break;
      case "ZodArray": node.k = "array"; node.el = walk(t.element); break;
      case "ZodRecord": node.k = "record"; node.val = walk(t.valueSchema); break;
      case "ZodEnum": node.k = "enum"; node.options = [...t.options]; break;
      case "ZodLiteral": node.k = "literal"; node.value = t.value; break;
      case "ZodBoolean": node.k = "boolean"; break;
      case "ZodNumber": node.k = "number"; break;
      case "ZodUnion": node.k = "union"; node.options = t.options.map(walk); break;
      default: node.k = "string";
    }
    if (s.isOptional()) node.opt = true;
    // The form seeds a default only when the outermost wrapper declares it.
    if (typeName(s) === "ZodDefault") node.def = s.parse(undefined);
    return node;
  }
  return walk(schema);
}
