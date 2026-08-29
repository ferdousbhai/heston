import { type ResearchSourceItem } from './research-contracts'

const COMPANY_WORDS_IGNORED = new Set([
  'CLASS', 'COMPANY', 'CORP', 'CORPORATION', 'ENERGY', 'GROUP', 'HOLDINGS',
  'INCORPORATED', 'LIMITED', 'PLATFORMS', 'TECHNOLOGIES', 'TRUST',
])

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function evidenceText(item: ResearchSourceItem): string {
  return [item.title, item.context, item.outbound?.label].filter(Boolean).join('\n')
}

function hasExplicitTicker(text: string, symbol: string): boolean {
  const token = escaped(symbol)
  const cashtag = new RegExp(`\\$${token}(?=$|[^A-Za-z0-9.])`, 'i')
  const uppercaseToken = new RegExp(`(?:^|[^A-Z0-9.])${token}(?=$|[^A-Z0-9.])`)
  return cashtag.test(text) || uppercaseToken.test(text)
}

function distinctiveNameWords(name: string, symbol: string): string[] {
  return [...new Set(name.toUpperCase().match(/[A-Z0-9]+/g) ?? [])]
    .filter((word) => word.length >= 5 && word !== symbol && !COMPANY_WORDS_IGNORED.has(word))
    .slice(0, 2)
}

function hasInstrumentName(text: string, ticker: { name?: string; symbol: string }): boolean {
  if (!ticker.name) return false
  return distinctiveNameWords(ticker.name, ticker.symbol).some((word) => (
    new RegExp(`(?:^|[^A-Za-z0-9])${escaped(word)}(?=$|[^A-Za-z0-9])`, 'i').test(text)
  ))
}

/**
 * Attach only code-verifiable symbol associations to untrusted research text.
 * Exact cashtags/uppercase tickers and distinctive broker-supplied name words
 * keep lookalikes such as SPCX and SpaceX from becoming interchangeable.
 */
export function bindEvidenceSymbols(
  items: readonly ResearchSourceItem[],
  tickers: readonly { name?: string; symbol: string }[],
): ResearchSourceItem[] {
  return items.map((item) => {
    const symbols = new Set(item.symbols ?? (item.marketMover ? [item.marketMover.symbol] : []))
    const text = evidenceText(item)
    for (const ticker of tickers) {
      if (hasExplicitTicker(text, ticker.symbol) || hasInstrumentName(text, ticker)) symbols.add(ticker.symbol)
    }
    return symbols.size ? { ...item, symbols: [...symbols] } : item
  })
}
