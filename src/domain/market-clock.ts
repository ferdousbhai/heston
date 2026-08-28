const NEW_YORK_TIME_ZONE = 'America/New_York'

const NEW_YORK_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  day: '2-digit', month: '2-digit', timeZone: NEW_YORK_TIME_ZONE, year: 'numeric',
})
const NEW_YORK_TIME_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit', hourCycle: 'h23', minute: '2-digit', second: '2-digit', timeZone: NEW_YORK_TIME_ZONE,
})
const NEW_YORK_WEEKDAY_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: NEW_YORK_TIME_ZONE, weekday: 'long',
})

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
  const dateParts = NEW_YORK_DATE_FORMATTER.formatToParts(now)
  const timeParts = NEW_YORK_TIME_FORMATTER.formatToParts(now)
  const weekday = NEW_YORK_WEEKDAY_FORMATTER.format(now)
  return {
    asOf: now.toISOString(),
    localDate: `${part(dateParts, 'year')}-${part(dateParts, 'month')}-${part(dateParts, 'day')}`,
    localTime: `${part(timeParts, 'hour')}:${part(timeParts, 'minute')}:${part(timeParts, 'second')}`,
    timeZone: NEW_YORK_TIME_ZONE,
    weekday,
  }
}
