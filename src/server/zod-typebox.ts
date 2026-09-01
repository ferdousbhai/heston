import { z } from 'zod'
import { Type } from 'typebox'

/** Generate one model JSON Schema from the same Zod contract enforced at the server boundary. */
export function zodTypeBoxSchema<T extends z.ZodType>(schema: T) {
  const jsonSchema = { ...z.toJSONSchema(schema) }
  Reflect.deleteProperty(jsonSchema, '$schema')
  Reflect.deleteProperty(jsonSchema, '~standard')
  return Type.Unsafe<z.infer<T>>(jsonSchema)
}
