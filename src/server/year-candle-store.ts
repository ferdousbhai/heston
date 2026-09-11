import { z } from 'zod'

import { CandlePointSchema, MAX_YEAR_CANDLES, type CandlePoint } from '../domain/candle'
import { EquitySymbolSchema } from '../domain/instrument'
import { D1_MAX_BOUND_PARAMETERS } from './d1-limits'

const StoredClosesSchema = z.array(CandlePointSchema).max(MAX_YEAR_CANDLES)

// One bound parameter per symbol, so a long watchlist is read in statement-sized chunks.
const SYMBOL_CHUNK_SIZE = D1_MAX_BOUND_PARAMETERS

// A stored row that no longer parses is treated as absent rather than fatal: the year chart is
// decoration over live prices, and one poisoned row must not take the whole market read down.
const StoredYearAnchorRowSchema = z.object({ symbol: z.string(), year_ago_close: z.number() })
const StoredYearSeriesRowSchema = z.object({ as_of: z.string(), symbol: z.string(), closes_json: z.string() })

/**
 * Where each symbol's year began. The snapshot needs only this to sort by return and print the
 * move; the series itself is large enough that carrying it in every market response cost more
 * than the chart it draws.
 */
export async function readYearAgoCloses(
  db: D1Database,
  symbols: readonly string[],
): Promise<Map<string, number>> {
  const anchors = new Map<string, number>()
  for (let start = 0; start < symbols.length; start += SYMBOL_CHUNK_SIZE) {
    const chunk = symbols.slice(start, start + SYMBOL_CHUNK_SIZE)
    const placeholders = chunk.map(() => '?').join(', ')
    const { results } = await db.prepare(
      `SELECT symbol, year_ago_close FROM year_candles
        WHERE symbol IN (${placeholders}) AND year_ago_close IS NOT NULL`,
    ).bind(...chunk).all()
    for (const result of results) {
      const row = StoredYearAnchorRowSchema.safeParse(result)
      if (row.success && row.data.year_ago_close > 0) anchors.set(row.data.symbol, row.data.year_ago_close)
    }
  }
  return anchors
}

/**
 * Every stored series, oldest close first, with the oldest refresh among them: one instant has
 * to stand for the whole answer, and the oldest is the only one that is true of every row in it.
 */
export async function readYearCandleSeries(db: D1Database): Promise<{ asOf?: string; series: Map<string, number[]> }> {
  const series = new Map<string, number[]>()
  let asOf: string | undefined
  const { results } = await db.prepare('SELECT symbol, closes_json, as_of FROM year_candles').all()
  for (const result of results) {
    const row = StoredYearSeriesRowSchema.safeParse(result)
    if (!row.success) continue
    const closes = StoredClosesSchema.safeParse(JSON.parse(row.data.closes_json))
    if (!closes.success || !closes.data.length) continue
    series.set(row.data.symbol, closes.data.map((point) => point.close))
    if (asOf === undefined || row.data.as_of < asOf) asOf = row.data.as_of
  }
  return { asOf, series }
}

export function yearCandlesUpsertStatement(
  db: D1Database,
  symbol: string,
  asOf: string,
  closes: readonly CandlePoint[],
): D1PreparedStatement {
  const stored = StoredClosesSchema.parse(closes).slice(-MAX_YEAR_CANDLES)
  return db.prepare(
    `INSERT INTO year_candles (symbol, as_of, closes_json, year_ago_close)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(symbol) DO UPDATE SET
       as_of = excluded.as_of,
       closes_json = excluded.closes_json,
       year_ago_close = excluded.year_ago_close`,
  ).bind(
    EquitySymbolSchema.parse(symbol),
    asOf,
    JSON.stringify(stored),
    stored[0]?.close ?? null,
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
