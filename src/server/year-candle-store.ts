import { z } from 'zod'

import { CandlePointSchema, MAX_YEAR_CANDLES, type CandlePoint } from '../domain/candle'
import { EquitySymbolSchema } from '../domain/instrument'

const StoredYearCandleRowSchema = z.object({
  symbol: z.string(),
  as_of: z.string(),
  closes_json: z.string(),
})

const StoredClosesSchema = z.array(CandlePointSchema).max(MAX_YEAR_CANDLES)

/** D1 binds a bounded parameter list, so a long watchlist is read in request-sized chunks. */
const SYMBOL_CHUNK_SIZE = 90

export type YearCandleSeries = { asOf: string; closes: CandlePoint[] }

/**
 * A stored row that no longer parses is treated as absent rather than fatal: the year chart is
 * decoration over live prices, and one poisoned row must not take the whole market read down.
 */
export async function readYearCandles(
  db: D1Database,
  symbols: readonly string[],
): Promise<Map<string, YearCandleSeries>> {
  const series = new Map<string, YearCandleSeries>()
  for (let start = 0; start < symbols.length; start += SYMBOL_CHUNK_SIZE) {
    const chunk = symbols.slice(start, start + SYMBOL_CHUNK_SIZE)
    if (!chunk.length) continue
    const placeholders = chunk.map(() => '?').join(', ')
    const { results } = await db.prepare(
      `SELECT symbol, as_of, closes_json FROM year_candles WHERE symbol IN (${placeholders})`,
    ).bind(...chunk).all()
    for (const result of results) {
      const row = StoredYearCandleRowSchema.safeParse(result)
      if (!row.success) continue
      const closes = StoredClosesSchema.safeParse(JSON.parse(row.data.closes_json))
      if (!closes.success) continue
      series.set(row.data.symbol, { asOf: row.data.as_of, closes: closes.data })
    }
  }
  return series
}

export function yearCandlesUpsertStatement(
  db: D1Database,
  symbol: string,
  asOf: string,
  closes: readonly CandlePoint[],
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO year_candles (symbol, as_of, closes_json)
     VALUES (?, ?, ?)
     ON CONFLICT(symbol) DO UPDATE SET as_of = excluded.as_of, closes_json = excluded.closes_json`,
  ).bind(
    EquitySymbolSchema.parse(symbol),
    asOf,
    JSON.stringify(StoredClosesSchema.parse(closes).slice(-MAX_YEAR_CANDLES)),
  )
}

export async function upsertYearCandles(
  db: D1Database,
  asOf: string,
  series: ReadonlyMap<string, readonly CandlePoint[]>,
): Promise<void> {
  const statements = [...series]
    .filter(([, closes]) => closes.length > 0)
    .map(([symbol, closes]) => yearCandlesUpsertStatement(db, symbol, asOf, closes))
  if (statements.length) await db.batch(statements)
}
