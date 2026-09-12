import { describe, expect, it } from 'vitest'

import { readSymbolEvidence } from '../src/server/symbol-evidence'
import { recordSymbolEvidence } from '../src/server/symbol-evidence-tool'
import { markdownBrowser, unreadableBrowser } from './fake-browser'
import { migrationStore } from './sqlite-d1'

const NOW = new Date('2026-09-02T13:45:00.000Z')
const LATER = new Date('2026-09-04T09:00:00.000Z')
const SOURCE_URL = 'https://www.reuters.com/technology/nvidia-supply'
// The address a reader is given back is the canonical one, so the tracking parameters an agent
// copied out of its browser are not part of what the card cites.
const SUBMITTED_URL = `${SOURCE_URL}?utm_source=newsletter`
const PAGE_MARKDOWN = '# NVIDIA\n\nThe company **signed a multi-year supply agreement** this week.'

function evidence() {
  return {
    byline: 'volwatcher',
    note: 'Visibility into next year\'s demand, not this quarter\'s.',
    quote: 'signed a multi-year supply agreement',
    sourceTitle: 'NVIDIA supply agreement',
    sourceUrl: SUBMITTED_URL,
    symbol: 'nvda',
  }
}

async function memberStore() {
  const store = await migrationStore()
  store.sqlite.prepare(
    `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
     VALUES (?, ?, ?, 1, ?, ?)`,
  ).run('member-1', 'Member', 'member@example.com', 'now', 'now')
  return store
}

describe('recording a quoted passage under a symbol', () => {
  it('binds the quote to the page the Worker read and returns it to every reader', async () => {
    const store = await memberStore()
    try {
      const result = await recordSymbolEvidence(
        { BROWSER: markdownBrowser(PAGE_MARKDOWN), DB: store.database },
        'member-1',
        evidence(),
        { now: NOW },
      )

      expect(result.status).toBe('recorded')
      const cards = await readSymbolEvidence(store.database, 'NVDA')
      expect(cards).toEqual([{
        byline: 'volwatcher',
        id: result.status === 'recorded' ? result.id : '',
        note: 'Visibility into next year\'s demand, not this quarter\'s.',
        quote: 'signed a multi-year supply agreement',
        recordedAt: NOW.toISOString(),
        sourceTitle: 'NVIDIA supply agreement',
        sourceUrl: SOURCE_URL,
        symbol: 'NVDA',
      }])
      // The account behind the card never leaves the server: the row has the recorder, the
      // public read has no column for it, and the byline is the whole of the attribution.
      expect(Object.keys(cards[0]!)).not.toContain('recordedByUserId')
      expect(store.sqlite.prepare('SELECT recorded_by_user_id FROM symbol_evidence').get())
        .toEqual({ recorded_by_user_id: 'member-1' })
    } finally {
      store.sqlite.close()
    }
  })

  it('refreshes the card when the same passage is recorded again, rather than duplicating it', async () => {
    const store = await memberStore()
    try {
      const first = await recordSymbolEvidence(
        { BROWSER: markdownBrowser(PAGE_MARKDOWN), DB: store.database },
        'member-1',
        evidence(),
        { now: NOW },
      )
      // The same passage, spelled with the markdown emphasis the page renders it with, and
      // cited through the uncanonicalized address: the same card either way.
      const again = await recordSymbolEvidence(
        { BROWSER: markdownBrowser(PAGE_MARKDOWN), DB: store.database },
        'member-1',
        { ...evidence(), quote: '**signed a multi-year supply agreement**', sourceUrl: SOURCE_URL },
        { now: LATER },
      )

      expect(again).toEqual(first)
      const cards = await readSymbolEvidence(store.database, 'NVDA')
      expect(cards).toHaveLength(1)
      expect(cards[0]?.recordedAt).toBe(LATER.toISOString())
    } finally {
      store.sqlite.close()
    }
  })

  it('returns the newest cards first', async () => {
    const store = await memberStore()
    try {
      const env = { BROWSER: markdownBrowser(PAGE_MARKDOWN), DB: store.database }
      await recordSymbolEvidence(env, 'member-1', evidence(), { now: NOW })
      const { byline: _byline, note: _note, ...unsigned } = evidence()
      await recordSymbolEvidence(
        env,
        'member-1',
        { ...unsigned, quote: 'signed a multi-year' },
        { now: LATER },
      )

      const cards = await readSymbolEvidence(store.database, 'NVDA')
      expect(cards.map((card) => card.quote)).toEqual([
        'signed a multi-year',
        'signed a multi-year supply agreement',
      ])
      // An omitted note and byline are absent, not empty strings a card would render a gap for.
      expect(cards[0]).toMatchObject({ byline: null, note: null })
    } finally {
      store.sqlite.close()
    }
  })

  it('refuses a quote the page it re-read does not contain, with the reason', async () => {
    const store = await memberStore()
    try {
      const result = await recordSymbolEvidence(
        { BROWSER: markdownBrowser('# NVIDIA\n\nA page about something else entirely.'), DB: store.database },
        'member-1',
        evidence(),
        { now: NOW },
      )

      expect(result).toEqual({
        rejected: ['quote absent from its source: "signed a multi-year supply agreement"'],
        status: 'rejected',
      })
      expect(store.sqlite.prepare('SELECT COUNT(*) AS rows FROM symbol_evidence').get()).toEqual({ rows: 0 })
    } finally {
      store.sqlite.close()
    }
  })

  it('refuses an address that is not a readable https page, and a page that will not open', async () => {
    const store = await memberStore()
    try {
      await expect(recordSymbolEvidence(
        { BROWSER: markdownBrowser(PAGE_MARKDOWN), DB: store.database },
        'member-1',
        { ...evidence(), sourceUrl: 'http://192.168.1.4/internal' },
        { now: NOW },
      )).resolves.toEqual({
        rejected: ['sourceUrl: not a readable https page address'],
        status: 'rejected',
      })
      await expect(recordSymbolEvidence(
        { BROWSER: unreadableBrowser(), DB: store.database },
        'member-1',
        evidence(),
        { now: NOW },
      )).resolves.toEqual({ rejected: [`page did not open: ${SOURCE_URL}`], status: 'rejected' })
      expect(store.sqlite.prepare('SELECT COUNT(*) AS rows FROM symbol_evidence').get()).toEqual({ rows: 0 })
    } finally {
      store.sqlite.close()
    }
  })

  it('fails closed when the Worker cannot read a page at all', async () => {
    const store = await memberStore()
    try {
      await expect(recordSymbolEvidence({ DB: store.database }, 'member-1', evidence(), { now: NOW }))
        .rejects.toThrow('SymbolEvidence:page-reading-unavailable')
    } finally {
      store.sqlite.close()
    }
  })

  it('drops a member\'s cards with their account', async () => {
    const store = await memberStore()
    try {
      await recordSymbolEvidence(
        { BROWSER: markdownBrowser(PAGE_MARKDOWN), DB: store.database },
        'member-1',
        evidence(),
        { now: NOW },
      )
      store.sqlite.prepare('DELETE FROM "user" WHERE "id" = ?').run('member-1')

      expect(await readSymbolEvidence(store.database, 'NVDA')).toEqual([])
    } finally {
      store.sqlite.close()
    }
  })
})
