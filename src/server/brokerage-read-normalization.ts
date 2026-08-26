import { z } from 'zod'

import { envelopeRows, jsonNumber, jsonObject, type JsonObject, type JsonValue } from '../domain/json-payload'
import { ISO_DATE } from './brokerage-read-contracts'

type ItemEnvelope = { rows: JsonObject[]; totalItems?: number }

/** Broker text fields are compared and length-checked verbatim, so they are not trimmed on the way in. */
const BrokerTextSchema = z.string()

export function invalidResponse(label: string): never {
  throw new Error(`${label} returned an invalid response.`)
}

export function itemEnvelope(payload: JsonValue, label: string, maximumRows: number): ItemEnvelope {
  const body = jsonObject(payload)
  const data = jsonObject(body?.data ?? payload)
  const candidate = envelopeRows(payload)
  if (!candidate || candidate.length > maximumRows) return invalidResponse(label)
  const rows = candidate.map((value) => jsonObject(value) ?? invalidResponse(label))

  const rawPagination = body?.pagination ?? data?.pagination
  if (rawPagination === undefined || rawPagination === null) return { rows }
  const pagination = jsonObject(rawPagination) ?? invalidResponse(label)
  const rawTotal = pagination['total-items']
  if (rawTotal === undefined || rawTotal === null) return { rows }
  const totalItems = finiteNumber(rawTotal, label)
  if (!Number.isSafeInteger(totalItems) || totalItems < 0) return invalidResponse(label)
  return { rows, totalItems }
}

export function dataRecord(payload: JsonValue, label: string): JsonObject {
  const body = jsonObject(payload) ?? invalidResponse(label)
  const rawData = body.data ?? body
  return jsonObject(rawData) ?? invalidResponse(label)
}

export function optionalText(
  row: JsonObject,
  keys: readonly string[],
  label: string,
  maxLength = 160,
): string | undefined {
  for (const key of keys) {
    const value = row[key]
    if (value === undefined || value === null || value === '') continue
    const raw = BrokerTextSchema.safeParse(value).data
    if (raw === undefined) return invalidResponse(label)
    const normalized = raw.trim()
    if (!normalized || normalized.length > maxLength) return invalidResponse(label)
    return normalized
  }
  return undefined
}

export function requiredText(
  row: JsonObject,
  keys: readonly string[],
  label: string,
  maxLength = 160,
): string {
  return optionalText(row, keys, label, maxLength) ?? invalidResponse(label)
}

export function finiteNumber(value: JsonValue, label: string): number {
  return jsonNumber(value) ?? invalidResponse(label)
}

export function optionalNumber(row: JsonObject, keys: readonly string[], label: string): number | undefined {
  for (const key of keys) {
    const value = row[key]
    if (value === undefined || value === null || value === '') continue
    return finiteNumber(value, label)
  }
  return undefined
}

export function optionalRatioPercent(row: JsonObject, keys: readonly string[], label: string): number | undefined {
  const value = optionalNumber(row, keys, label)
  return value === undefined ? undefined : Math.round(value * 10_000) / 100
}

export function optionalBoolean(row: JsonObject, keys: readonly string[], label: string): boolean | undefined {
  for (const key of keys) {
    const value = row[key]
    if (value === undefined || value === null) continue
    return z.boolean().safeParse(value).data ?? invalidResponse(label)
  }
  return undefined
}

export function requiredIdentifier(row: JsonObject, key: string, label: string): string {
  const value = row[key]
  const numeric = z.number().safeParse(value).data
  if (numeric !== undefined && Number.isSafeInteger(numeric)) return String(numeric)
  const normalized = BrokerTextSchema.safeParse(value).data?.trim()
  if (normalized && normalized.length <= 64) return normalized
  return invalidResponse(label)
}

export function validDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value
}

export function optionalDate(row: JsonObject, keys: readonly string[], label: string): string | undefined {
  const value = optionalText(row, keys, label, 40)
  if (value === undefined) return undefined
  return validDate(value) ? value : invalidResponse(label)
}

export function optionalTimestamp(row: JsonObject, keys: readonly string[], label: string): string | undefined {
  const value = optionalText(row, keys, label, 40)
  if (value === undefined) return undefined
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) || Number.isNaN(Date.parse(value))) return invalidResponse(label)
  return value
}

export function requiredTimestamp(row: JsonObject, keys: readonly string[], label: string): string {
  return optionalTimestamp(row, keys, label) ?? invalidResponse(label)
}
