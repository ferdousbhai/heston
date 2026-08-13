type JsonRecord = Record<string, unknown>

function record(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null ? value as JsonRecord : {}
}

function matchesAccount(row: JsonRecord, accountNumber: string): boolean {
  if (!Object.hasOwn(row, 'account-number')) return true
  return typeof row['account-number'] === 'string' && row['account-number'].trim() === accountNumber
}

/** Normalize both tastytrade balance envelopes without guessing among multiple accounts. */
export function accountBalanceRecord(payload: unknown, accountNumber: string): JsonRecord | undefined {
  const body = record(payload)
  const rawData = body.data ?? payload
  const data = record(rawData)
  const items = Array.isArray(rawData) ? rawData : data.items
  if (Array.isArray(items)) {
    if (items.length !== 1) return undefined
    const row = record(items[0])
    return matchesAccount(row, accountNumber) ? row : undefined
  }
  return matchesAccount(data, accountNumber) ? data : undefined
}
