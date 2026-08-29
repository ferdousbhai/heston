export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10)
}

/**
 * A stored brief is keyed by its market date, so a rerun replaces that day's row
 * instead of appending a second brief. The coverage search excludes exactly this
 * id, so the writer and the reader must derive it the same way.
 */
export function researchBriefId(marketDate: string): string {
  return `brief-${marketDate}`
}
