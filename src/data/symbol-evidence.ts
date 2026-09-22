import { SymbolEvidenceResponseSchema, type SymbolEvidence } from '../domain/symbol-evidence'
import { loadPublicJson } from './public-json'

export async function loadSymbolEvidence(symbol: string, signal?: AbortSignal): Promise<SymbolEvidence[]> {
  const query = new URLSearchParams({ symbol })
  return (await loadPublicJson(`/api/public-symbol-evidence?${query}`, SymbolEvidenceResponseSchema, signal)).evidence
}
