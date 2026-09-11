/**
 * Distinct A-Z symbols by index (A, B, ... Z, AA, AB, ...), the shape the
 * `internal_watchlist_items` symbol CHECK constraint admits. Tests that need to fill the
 * watchlist to its bound share this so the constraint is encoded in one place.
 */
export function symbolAt(index: number): string {
  let value = index + 1
  let symbol = ''
  while (value > 0) {
    value--
    symbol = String.fromCharCode(65 + value % 26) + symbol
    value = Math.floor(value / 26)
  }
  return symbol
}
