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
const NumericSchema = z.union([z.number(), z.string().trim().min(1)])
  .transform(Number)
  .refine(Number.isFinite)

/** Non-empty trimmed text. Values that are not strings are treated as absent. */
const TextSchema = z.string().trim().min(1)

/** Text that a payload may encode as either a JSON string or a JSON number. */
const LooseTextSchema = z.union([z.string(), z.number()])
  .transform(String)
  .pipe(TextSchema)

/**
 * One decoded JSON object, or undefined when the value is an array, a primitive, or absent.
 * Use this where a missing object is a distinguishable outcome the caller reacts to.
 */
export function jsonObject(value: JsonValue): JsonObject | undefined {
  return JsonObjectSchema.safeParse(value).data
}

/**
 * One decoded JSON object, with anything that is not an object read back as an empty object.
 * Use this where a missing object simply means every field is absent, so lookups can chain.
 */
export function jsonObjectOrEmpty(value: JsonValue): JsonObject {
  return JsonObjectSchema.safeParse(value).data ?? {}
}

/** Non-empty trimmed text, or undefined when the value is absent, blank, or not a string. */
export function jsonText(value: JsonValue): string | undefined {
  return TextSchema.safeParse(value).data
}

/** Non-empty trimmed text, with absent, blank, and non-string values read back as an empty string. */
export function jsonTextOrEmpty(value: JsonValue): string {
  return TextSchema.safeParse(value).data ?? ''
}

/** Like {@link jsonText}, but also accepts text a payload encoded as a JSON number. */
export function jsonLooseText(value: JsonValue): string | undefined {
  return LooseTextSchema.safeParse(value).data
}

/** A finite number from a JSON number or a decimal string, or undefined when neither resolves. */
export function jsonNumber(value: JsonValue): number | undefined {
  return NumericSchema.safeParse(value).data
}

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

/**
 * The `pagination.total-items` count a brokerage collection envelope reports, or undefined
 * when it reports none that can be trusted. A total that is not a non-negative safe integer
 * reads back as undefined, so callers must treat undefined as "the page count is unknown",
 * never as "there is nothing more".
 */
export function envelopeTotalItems(payload: JsonValue): number | undefined {
  const body = jsonObject(payload)
  const data = jsonObject(body?.data)
  const pagination = jsonObject(body?.pagination) ?? jsonObject(data?.pagination)
  const total = jsonNumber(pagination?.['total-items'])
  return total !== undefined && Number.isSafeInteger(total) && total >= 0 ? total : undefined
}
