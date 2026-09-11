const RESEARCH_TIME_ZONE = 'America/New_York'
const RESEARCH_WEEKDAYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri'])
const DAYS_IN_WEEK = 7

export const DAILY_RESEARCH_SCHEDULE = {
  hour: 9,
  minute: 30,
  timeZone: RESEARCH_TIME_ZONE,
} as const

const WALL_CLOCK_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
  minute: '2-digit',
  month: '2-digit',
  timeZone: RESEARCH_TIME_ZONE,
  weekday: 'short',
  year: 'numeric',
})

type WallClockParts = {
  day: number
  hour: number
  minute: number
  month: number
  weekday: string
  year: number
}

function wallClockParts(date: Date): WallClockParts {
  const parts = Object.fromEntries(
    WALL_CLOCK_FORMATTER.formatToParts(date).map((candidate) => [candidate.type, candidate.value]),
  )
  return {
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    month: Number(parts.month),
    weekday: parts.weekday ?? '',
    year: Number(parts.year),
  }
}

function dateAtResearchWallTime(year: number, month: number, day: number): Date {
  const intendedWallTime = Date.UTC(
    year,
    month - 1,
    day,
    DAILY_RESEARCH_SCHEDULE.hour,
    DAILY_RESEARCH_SCHEDULE.minute,
  )
  const approximate = wallClockParts(new Date(intendedWallTime))
  const representedWallTime = Date.UTC(
    approximate.year,
    approximate.month - 1,
    approximate.day,
    approximate.hour,
    approximate.minute,
  )
  const candidate = new Date(intendedWallTime - (representedWallTime - intendedWallTime))
  const resolved = wallClockParts(candidate)
  if (
    resolved.year !== year || resolved.month !== month || resolved.day !== day
    || resolved.hour !== DAILY_RESEARCH_SCHEDULE.hour
    || resolved.minute !== DAILY_RESEARCH_SCHEDULE.minute
  ) {
    throw new Error('Daily research schedule could not be resolved in New York time.')
  }
  return candidate
}

function shiftedCalendarDate(parts: WallClockParts, days: number): Pick<WallClockParts, 'day' | 'month' | 'year'> {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days))
  return {
    day: shifted.getUTCDate(),
    month: shifted.getUTCMonth() + 1,
    year: shifted.getUTCFullYear(),
  }
}

export function nextDailyResearchRun(now = new Date()): Date {
  if (!Number.isFinite(now.getTime())) throw new Error('Daily research schedule requires a valid date.')
  const current = wallClockParts(now)
  // A weekday schedule always has a candidate within one complete calendar week.
  for (let offset = 0; offset <= DAYS_IN_WEEK; offset += 1) {
    const date = shiftedCalendarDate(current, offset)
    const candidate = dateAtResearchWallTime(date.year, date.month, date.day)
    if (candidate.getTime() < now.getTime()) continue
    if (RESEARCH_WEEKDAYS.has(wallClockParts(candidate).weekday)) return candidate
  }
  throw new Error('Next daily research run could not be resolved.')
}
