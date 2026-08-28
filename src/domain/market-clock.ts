const NEW_YORK_TIME_ZONE = 'America/New_York'

export type NewYorkClock = {
  asOf: string
  localDate: string
  localTime: string
  timeZone: typeof NEW_YORK_TIME_ZONE
  weekday: string
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((candidate) => candidate.type === type)?.value ?? ''
}

export function newYorkClock(now = new Date()): NewYorkClock {
  if (!Number.isFinite(now.getTime())) throw new Error('New York clock requires a valid date.')
  const dateParts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit', month: '2-digit', timeZone: NEW_YORK_TIME_ZONE, year: 'numeric',
  }).formatToParts(now)
  const timeParts = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', hourCycle: 'h23', minute: '2-digit', second: '2-digit', timeZone: NEW_YORK_TIME_ZONE,
  }).formatToParts(now)
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: NEW_YORK_TIME_ZONE, weekday: 'long',
  }).format(now)
  return {
    asOf: now.toISOString(),
    localDate: `${part(dateParts, 'year')}-${part(dateParts, 'month')}-${part(dateParts, 'day')}`,
    localTime: `${part(timeParts, 'hour')}:${part(timeParts, 'minute')}:${part(timeParts, 'second')}`,
    timeZone: NEW_YORK_TIME_ZONE,
    weekday,
  }
}
