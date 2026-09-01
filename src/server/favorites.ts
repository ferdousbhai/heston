import { FavoriteSymbolsSchema, MAX_FAVORITE_SYMBOLS } from '../domain/favorites'
import { OWNER_EMAIL } from './auth'

export async function readFavoriteSymbols(database: D1Database, userId: string): Promise<string[]> {
  const result = await database.prepare(
    `SELECT symbol
     FROM user_favorite_symbols
     WHERE user_id = ?
     ORDER BY symbol
     LIMIT ?`,
  ).bind(userId, MAX_FAVORITE_SYMBOLS).all<{ symbol: string }>()
  return FavoriteSymbolsSchema.parse(result.results.map((row) => row.symbol))
}

/**
 * Device bootstrap is additive: insert-only merges commute across concurrent sign-ins,
 * so no device can replace favorites collected anonymously on another device.
 */
export async function mergeFavoriteSymbols(
  database: D1Database,
  userId: string,
  symbols: readonly string[],
  now = new Date(),
): Promise<string[]> {
  const incoming = [...new Set(FavoriteSymbolsSchema.parse(symbols))].sort()
  if (incoming.length) {
    const insert = database.prepare(
      `INSERT INTO user_favorite_symbols (user_id, symbol, created_at)
       SELECT ?, ?, ?
       WHERE (SELECT COUNT(*) FROM user_favorite_symbols WHERE user_id = ?) < ?
       ON CONFLICT(user_id, symbol) DO NOTHING`,
    )
    await database.batch(incoming.map((symbol) => insert.bind(
      userId,
      symbol,
      now.toISOString(),
      userId,
      MAX_FAVORITE_SYMBOLS,
    )))
  }
  return readFavoriteSymbols(database, userId)
}

export async function removeFavoriteSymbols(
  database: D1Database,
  userId: string,
  symbols: readonly string[],
): Promise<string[]> {
  const outgoing = [...new Set(FavoriteSymbolsSchema.min(1).parse(symbols))]
  const remove = database.prepare(
    'DELETE FROM user_favorite_symbols WHERE user_id = ? AND symbol = ?',
  )
  await database.batch(outgoing.map((symbol) => remove.bind(userId, symbol)))
  return readFavoriteSymbols(database, userId)
}


/**
 * The owner's starred symbols, addressed by the owner identity itself. Dan is the owner's
 * agent and runs with no request in scope, so there is no viewer to key by — and a starred
 * symbol is the clearest record of what the owner is deliberately monitoring, which is
 * exactly the context an opening question should be grounded in.
 */
export async function readOwnerFavoriteSymbols(database: D1Database): Promise<string[]> {
  const owner = await database.prepare(
    'SELECT id FROM user WHERE lower(email) = ? LIMIT 1',
  ).bind(OWNER_EMAIL).first<{ id: string }>()
  if (!owner) return []
  return readFavoriteSymbols(database, owner.id)
}
