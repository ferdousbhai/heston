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

export const JsonObjectSchema = z.record(z.string(), z.custom<JsonValue>())
export type JsonObject = z.infer<typeof JsonObjectSchema>

export const JsonArraySchema = z.array(z.custom<JsonValue>())

export const JsonObjectArraySchema = z.array(JsonObjectSchema)

const NumericSchema = z.union([z.number(), z.string().trim().min(1)])
  .transform(Number)
  .refine(Number.isFinite)

const TextSchema = z.string().trim().min(1)

const LooseTextSchema = z.union([z.string(), z.number()])
  .transform(String)
  .pipe(TextSchema)

export function jsonObject(value: JsonValue): JsonObject | undefined {
  return JsonObjectSchema.safeParse(value).data
}

export function jsonObjectOrEmpty(value: JsonValue): JsonObject {
  return JsonObjectSchema.safeParse(value).data ?? {}
}

export function jsonText(value: JsonValue): string | undefined {
  return TextSchema.safeParse(value).data
}

export function jsonTextOrEmpty(value: JsonValue): string {
  return TextSchema.safeParse(value).data ?? ''
}

export function jsonLooseText(value: JsonValue): string | undefined {
  return LooseTextSchema.safeParse(value).data
}

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
