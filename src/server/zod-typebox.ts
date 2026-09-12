import { z } from 'zod'
import { Type } from 'typebox'

import {
  JsonArraySchema,
  type JsonObject,
  jsonObject,
  JsonObjectSchema,
  type JsonValue,
} from '../domain/json-payload'

/**
 * Zod stamps every `.int()` with JavaScript's safe-integer range. Published to a model that
 * reads as contract -- `maximum: 9007199254740991` on a source index says an index may run to
 * nine quadrillion -- when all it says is "a JavaScript integer". Drop exactly those two
 * bounds: every real limit here comes from a policy, a provider, or a named budget far below
 * them, so a bound equal to the language's own is the language's and not the contract's.
 */
function withoutSafeIntegerBounds(schema: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(schema)
    .filter(([keyword, value]) => !(
      (keyword === 'maximum' && value === Number.MAX_SAFE_INTEGER)
      || (keyword === 'minimum' && value === -Number.MAX_SAFE_INTEGER)
    ))
    .map(([keyword, value]) => [keyword, strippedSubschema(value)]))
}

/** Bounds sit on nested subschemas, which arrive as objects or as branches of an array. */
function strippedSubschema(value: JsonValue): JsonValue {
  const branches = JsonArraySchema.safeParse(value).data
  if (branches) return branches.map(strippedSubschema)
  const nested = jsonObject(value)
  return nested ? withoutSafeIntegerBounds(nested) : value
}

/** Generate one model JSON Schema from the same Zod contract enforced at the server boundary. */
export function zodTypeBoxSchema<T extends z.ZodType>(schema: T) {
  // `$schema` is the dialect, not part of the tool's input contract, and MCP clients do not read
  // it. Re-parsed as plain JSON because that is all a published schema is by the time it ships.
  const { $schema: _$schema, ...jsonSchema } = z.toJSONSchema(schema)
  return Type.Unsafe<z.infer<T>>(withoutSafeIntegerBounds(JsonObjectSchema.parse(jsonSchema)))
}
