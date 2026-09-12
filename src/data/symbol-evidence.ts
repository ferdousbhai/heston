import { SymbolEvidenceResponseSchema, type SymbolEvidence } from '../domain/symbol-evidence'

export async function loadSymbolEvidence(symbol: string, signal?: AbortSignal): Promise<SymbolEvidence[]> {
  const query = new URLSearchParams({ symbol })
  const response = await fetch(`/api/public-symbol-evidence?${query}`, {
    headers: { Accept: 'application/json' },
    signal,
  })
  if (!response.ok) throw new Error(`Symbol evidence request failed (${response.status})`)
  return SymbolEvidenceResponseSchema.parse(await response.json()).evidence
}
