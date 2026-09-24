import { describe, expect, it } from 'vitest'
import { Compile } from 'typebox/compile'

import { IsoDateType, isValidIsoDate, textMentionsIsoDate, textMentionsDateWithinHorizon } from '../src/domain/iso-date'

describe('ISO date contract', () => {
  it.each([
    '2024-02-29',
    '2026-08-30',
  ])('accepts the real calendar date %s', (value) => {
    expect(isValidIsoDate(value)).toBe(true)
  })

  it.each([
    '2026-02-29',
    '2026-04-31',
    '2026-8-30',
    'not-a-date',
  ])('rejects the malformed or impossible date %s', (value) => {
    expect(isValidIsoDate(value)).toBe(false)
  })

  it('advertises the wire shape while semantic validation checks the calendar', () => {
    const validator = Compile(IsoDateType)

    expect(validator.Check('2026-02-30')).toBe(true)
    expect(isValidIsoDate('2026-02-30')).toBe(false)
  })
})

describe('provenance date matching', () => {
  it.each([
    ['2026-09-24', 'Event on 2026-09-24 at the campus'],
    ['2026-09-24', 'Scheduled for September 24, 2026'],
    ['2026-09-24', 'scheduled for sep 24 2026'],
    ['2026-09-24', 'Held 24 September 2026 in Hawthorne'],
    ['2026-09-24', 'Starts 9/24/2026'],
    ['2026-01-05', 'Due (1/5/2026) per the notice'],
    ['2026-09-01', 'Held 1 September 2026 in Hawthorne'],
    // Multi-day events, which no single rendering can match.
    ['2026-09-22', 'SEPTEMBER 22-24 2026 | CAESARS FORUM'],
    ['2026-08-31', 'August 31 - September 3, 2026, more than 10,000 attendees'],
  ])('accepts %s rendered as %s', (date, text) => {
    expect(textMentionsIsoDate(text, date)).toBe(true)
  })

  it.each([
    // The day is present but no year vouches for it, so the page does not establish the date.
    ['2026-10-20', 'October 20 | Berlin'],
    // A year far from the day is a different date further down the page.
    ['2026-09-24', 'September 24 in a paragraph of prose long enough that the mention of 2026 sits well beyond the window'],
    ['2026-09-24', 'Upcoming events will be announced'],
    ['2026-09-24', 'September 25, 2026'],
    ['2026-09-24', 'September 24, 2027'],
    // The year printed with the date is another one; the claimed year further on is not its year.
    ['2026-09-09', "Last year's summit was held September 9, 2025; the 2026 date is not yet set."],
    // A year in the next clause is not the mention's year.
    ['2026-09-09', 'In 2025, on September 9, the firm set its 2026 targets.'],
    // A longer number or date that merely contains a rendering is a different date.
    ['2026-01-05', 'Rescheduled to 11/5/2026 after the vote'],
    ['2026-02-01', 'Results follow on 12/1/2026'],
    ['2026-09-01', 'Held 21 September 2026 in Hawthorne'],
    ['2026-09-01', 'Held 21 Sep 2026 in Hawthorne'],
    ['2026-01-05', 'Reference 2026-01-050 in the filing'],
  ])('refuses %s against %s', (date, text) => {
    expect(textMentionsIsoDate(text, date)).toBe(false)
  })
})

describe('horizon-scoped date matching', () => {
  const TODAY = '2026-09-02'
  const HORIZON = '2027-03-01'

  it('accepts a year-less mention when the horizon makes the year redundant', () => {
    expect(textMentionsDateWithinHorizon(
      'Ternus takes the stage on September 9 with the first foldable iPhone.',
      '2026-09-09', TODAY, HORIZON,
    )).toBe(true)
    expect(textMentionsDateWithinHorizon(
      'The export ban runs through Sept. 30th at least.',
      '2026-09-30', TODAY, HORIZON,
    )).toBe(true)
  })

  it('still refuses a mention whose printed year is a different one', () => {
    expect(textMentionsDateWithinHorizon(
      'Back on September 9, 2025 the company said otherwise.',
      '2026-09-09', TODAY, HORIZON,
    )).toBe(false)
    expect(textMentionsDateWithinHorizon(
      "Last year's summit was held September 9, 2025; the 2026 date is not yet set.",
      '2026-09-09', TODAY, HORIZON,
    )).toBe(false)
  })

  it('refuses a mention whose different year is printed just before it', () => {
    expect(textMentionsDateWithinHorizon(
      'In 2025, on September 9 the firm reported otherwise.',
      '2026-09-09', TODAY, HORIZON,
    )).toBe(false)
    // The claimed year before the mention is no reason to refuse it.
    expect(textMentionsDateWithinHorizon(
      'In 2026, on September 9 the firm takes the stage.',
      '2026-09-09', TODAY, HORIZON,
    )).toBe(true)
  })

  it('reads a year in another clause as no year rather than the mention\'s', () => {
    // The 2026 belongs to the targets; the 2025 before the mention still refuses it.
    expect(textMentionsDateWithinHorizon(
      'In 2025, on September 9, the firm set its 2026 targets.',
      '2026-09-09', TODAY, HORIZON,
    )).toBe(false)
    // The 2027 belongs to the guidance, so the year-less August 6 stands inside the horizon.
    expect(textMentionsDateWithinHorizon(
      'The company reports results on Thursday, August 6. Guidance for 2027 follows.',
      '2026-08-06', '2026-08-01', '2027-01-01',
    )).toBe(true)
  })

  it('never relaxes the year outside the horizon', () => {
    expect(textMentionsDateWithinHorizon(
      'A shareholder meeting is planned for June 1.',
      '2027-06-01', TODAY, HORIZON,
    )).toBe(false)
    expect(textMentionsDateWithinHorizon(
      'It happened on September 1.',
      '2026-09-01', TODAY, HORIZON,
    )).toBe(false)
  })

  it('keeps accepting fully dated renderings regardless of the horizon', () => {
    expect(textMentionsDateWithinHorizon(
      'The keynote is September 9, 2026 in Cupertino.',
      '2026-09-09', TODAY, HORIZON,
    )).toBe(true)
  })
})
