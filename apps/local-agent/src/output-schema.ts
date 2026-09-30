/** A bounded subset of JSON Schema suitable for strict structured model output. */
export function parseOutputSchema(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const fail = (): never => { throw new Error("Invalid structured-output schema"); };
  if (new TextEncoder().encode(JSON.stringify(value)).length > 16_000) return fail();
  let nodes = 0;
  const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
  function visit(v: unknown, depth: number): void {
    if (!object(v) || ++nodes > 200 || depth > 10) return fail();
    if (Object.keys(v).some(key => !["type", "properties", "required", "additionalProperties", "items", "enum", "anyOf", "description"].includes(key))) return fail();
    if (v.description !== undefined && (typeof v.description !== "string" || v.description.length > 1000)) return fail();
    if (v.anyOf !== undefined) {
      if (Object.keys(v).some(key => !["anyOf", "description"].includes(key)) || !Array.isArray(v.anyOf) || !v.anyOf.length || v.anyOf.length > 8) return fail();
      for (const variant of v.anyOf) visit(variant, depth + 1);
      return;
    }
    if (!["object", "array", "string", "number", "integer", "boolean", "null"].includes(String(v.type))) return fail();
    if (v.enum !== undefined && (!Array.isArray(v.enum) || !v.enum.length || v.enum.length > 100 || v.enum.some(item => item !== null && !["string", "number", "boolean"].includes(typeof item)))) return fail();
    if (Array.isArray(v.enum) && v.enum.some(item => v.type === "null" ? item !== null : v.type === "integer" ? typeof item !== "number" || !Number.isSafeInteger(item) : v.type === "number" ? typeof item !== "number" || !Number.isFinite(item) : typeof item !== v.type)) return fail();
    if (v.type === "object") {
      if (!object(v.properties) || !Array.isArray(v.required) || v.additionalProperties !== false || v.items !== undefined) return fail();
      const keys = Object.keys(v.properties);
      if (keys.some(key => !key || key.length > 128 || ["__proto__", "constructor", "prototype"].includes(key)) || new Set(v.required).size !== keys.length || v.required.length !== keys.length || v.required.some(key => typeof key !== "string" || !keys.includes(key))) return fail();
      for (const property of Object.values(v.properties)) visit(property, depth + 1);
    } else if (v.type === "array") {
      if (["properties", "required", "additionalProperties"].some(key => key in v)) return fail();
      visit(v.items, depth + 1);
    } else if (["properties", "required", "additionalProperties", "items"].some(key => key in v)) return fail();
  }
  if (!object(value) || value.type !== "object") return fail();
  visit(value, 0);
  return structuredClone(value);
}
