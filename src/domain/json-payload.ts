import { z } from 'zod'

/**
 * A decoded JSON document whose structure has not been validated yet. This is the
 * type of everything that crosses an HTTP or storage boundary before its own
 * schema runs; parse it into a domain type before relying on any field.
 * Absent fields read back as `undefined`, so it is part of the union.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | JsonValue[]
  | { [key: string]: JsonValue }

/** One decoded JSON object. Arrays and primitives are rejected. */
export const JsonObjectSchema = z.record(z.string(), z.custom<JsonValue>())
export type JsonObject = z.infer<typeof JsonObjectSchema>

/** A decoded JSON array whose elements have not been parsed yet. */
export const JsonArraySchema = z.array(z.custom<JsonValue>())

/** An array of JSON objects; elements that are not objects are rejected. */
export const JsonObjectArraySchema = z.array(JsonObjectSchema)

/** Broker and model payloads quote numbers as JSON numbers or decimal strings; both must resolve to a finite value. */
export const NumericSchema = z.union([z.number(), z.string().trim().min(1)])
  .transform(Number)
  .refine(Number.isFinite)

/** Non-empty trimmed text. Values that are not strings are treated as absent. */
export const TextSchema = z.string().trim().min(1)

/** Text that a payload may encode as either a JSON string or a JSON number. */
export const LooseTextSchema = z.union([z.string(), z.number()])
  .transform(String)
  .pipe(TextSchema)

/**
 * Brokerage collection endpoints wrap their rows as a bare array, as `data`, as
 * `data.items`, or as `items`. Returns the row array, or undefined when the payload
 * carries no collection at all.
 */
export function envelopeRows(payload: JsonValue): JsonValue[] | undefined {
  const body = JsonObjectSchema.safeParse(payload).data
  const rawData = body?.data ?? payload
  const data = JsonObjectSchema.safeParse(rawData).data
  return JsonArraySchema.safeParse(rawData).data
    ?? JsonArraySchema.safeParse(data?.items).data
    ?? JsonArraySchema.safeParse(body?.items).data
}
