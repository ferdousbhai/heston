import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  alreadyPublishedToday,
  grokLimitRemaining,
  isolatedMuseSettings,
  marketDate,
  museExecArgs,
  museRun,
  readGrokLimitRemaining,
  readMarketState,
  runResearchAgent,
  shouldRunForMarket,
  unattendedPromptSuffix,
} from '../ops/spice-agent/daily-research.mjs'

afterEach(() => vi.unstubAllGlobals())

it('parses launcher session responses and rejects invalid states and opening times', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ marketState: 'pre', marketOpensAt: '2026-09-16T13:30:00.000Z' })))
  await expect(readMarketState()).resolves.toEqual({ state: 'pre', opensAt: '2026-09-16T13:30:00.000Z' })
  for (const body of [{ marketState: 'unexpected' }, { marketState: 'open', marketOpensAt: 42 }, { marketState: 'closed', marketOpensAt: 'yesterday' }]) {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(body)))
    await expect(readMarketState()).rejects.toThrow('SpiceDailyResearch:invalid-market-session')
  }
})

describe('owner-machine daily research skip', () => {
  it('treats the stored id as today\'s brief when it matches the NY market date', () => {
    expect(alreadyPublishedToday('recommendations-2026-09-16', '2026-09-16')).toBe(true)
    expect(alreadyPublishedToday('recommendations-2026-09-11', '2026-09-16')).toBe(false)
    expect(alreadyPublishedToday(undefined, '2026-09-16')).toBe(false)
  })

  it('names the US cash-session calendar date', () => {
    expect(marketDate(new Date('2026-09-16T13:35:00.000Z'))).toBe('2026-09-16')
    // 9:35 ET is 13:35 UTC in EDT; before midnight ET is still that session.
    expect(marketDate(new Date('2026-09-17T03:59:00.000Z'))).toBe('2026-09-16')
  })

  it('runs while the equity session is open or still pre', () => {
    expect(shouldRunForMarket({ state: 'open' })).toBe(true)
    expect(shouldRunForMarket({ state: 'pre' })).toBe(true)
    expect(shouldRunForMarket({ state: 'closed' })).toBe(false)
    expect(shouldRunForMarket({ state: 'after' })).toBe(false)
    expect(shouldRunForMarket({ state: 'unknown' })).toBe(false)
  })

  it('catches up after hours when today\'s bell has already rung, and skips a holiday', () => {
    const open = '2026-09-16T13:30:00.000Z'
    const evening = new Date('2026-09-16T23:00:00.000Z')
    const beforeBell = new Date('2026-09-16T13:00:00.000Z')
    expect(shouldRunForMarket({ state: 'after', opensAt: open }, evening)).toBe(true)
    expect(shouldRunForMarket({ state: 'after', opensAt: open }, beforeBell)).toBe(false)
    expect(shouldRunForMarket({
      state: 'closed',
      opensAt: '2026-09-17T13:30:00.000Z',
    }, evening)).toBe(false)
    expect(shouldRunForMarket({ state: 'closed' }, evening)).toBe(false)
  })

  it('reads the tray limit as the fullest open window', () => {
    const now = new Date('2026-09-18T13:00:00.000Z')
    expect(grokLimitRemaining({
      limits: [
        { label: 'Weekly', percent: 0.9, resetsAt: '2026-09-23T05:08:42.000Z' },
        { label: 'Grok Build', percent: 0.99, resetsAt: '2026-09-23T05:08:42.000Z' },
      ],
    }, now)).toBeCloseTo(0.01, 5)
    // A reset window no longer binds.
    expect(grokLimitRemaining({
      limits: [
        { label: 'Weekly', percent: 0.99, resetsAt: '2026-09-10T05:08:42.000Z' },
        { label: 'Grok Build', percent: 0.2, resetsAt: '2026-09-23T05:08:42.000Z' },
      ],
    }, now)).toBeCloseTo(0.8, 5)
    for (const record of [{}, { limits: [] }, { limits: [{ label: 'Weekly' }] }, null]) {
      expect(grokLimitRemaining(record, now)).toBeUndefined()
    }
  })

  it('treats a missing, stale, or invalid limit record as unknown', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'spice-limit-test-'))
    try {
      const now = new Date('2026-09-18T13:00:00.000Z')
      await expect(readGrokLimitRemaining(join(directory, 'absent.json'), now)).resolves.toBeUndefined()
      const stale = join(directory, 'stale.json')
      await writeFile(stale, JSON.stringify({
        limits: [{ label: 'Weekly', percent: 0.5 }],
        updatedAt: '2026-09-18T10:00:00.000Z',
      }))
      await expect(readGrokLimitRemaining(stale, now)).resolves.toBeUndefined()
      const broken = join(directory, 'broken.json')
      await writeFile(broken, 'not json')
      await expect(readGrokLimitRemaining(broken, now)).resolves.toBeUndefined()
      const fresh = join(directory, 'fresh.json')
      await writeFile(fresh, JSON.stringify({
        limits: [{ label: 'Weekly', percent: 0.96 }],
        updatedAt: '2026-09-18T12:55:00.000Z',
      }))
      await expect(readGrokLimitRemaining(fresh, now)).resolves.toBeCloseTo(0.04, 5)
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('runs grok first and spends muse only when grok fails', async () => {
    const grok = vi.fn(async () => {})
    const muse = vi.fn(async () => {})
    await expect(runResearchAgent('prompt', 'token', { grok, muse })).resolves.toBe('grok')
    expect(muse).not.toHaveBeenCalled()
    grok.mockRejectedValueOnce(new Error('SpiceDailyResearch:grok-exit:1'))
    await expect(runResearchAgent('prompt', 'token', { grok, muse })).resolves.toBe('muse')
    expect(muse).toHaveBeenCalledTimes(1)
    grok.mockRejectedValueOnce(new Error('SpiceDailyResearch:grok-exit:1'))
    muse.mockRejectedValueOnce(new Error('SpiceDailyResearch:muse-exit:1'))
    await expect(runResearchAgent('prompt', 'token', { grok, muse })).rejects.toThrow('muse-exit:1')
  })

  it('skips grok when the caller already chose the spare', async () => {
    const grok = vi.fn(async () => {})
    const muse = vi.fn(async () => {})
    await expect(runResearchAgent('prompt', 'token', { grok, muse }, true)).resolves.toBe('muse')
    expect(grok).not.toHaveBeenCalled()
    expect(muse).toHaveBeenCalledTimes(1)
  })

  it('pins muse to an isolated workspace and keeps only the spice MCP server', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'spice-muse-settings-'))
    try {
      const source = join(directory, 'settings.json')
      await writeFile(source, JSON.stringify({
        model: 'muse-spark-1.3-contributor',
        mcpServers: { cloudflare: { url: 'https://mcp.cloudflare.com/mcp' } },
        provider: 'meta',
        schema_version: 1,
      }))
      const settings = await isolatedMuseSettings('spice-token', source)
      expect(settings).toEqual({
        model: 'muse-spark-1.3-contributor',
        mcpServers: {
          spice: { headers: { Authorization: 'Bearer spice-token' }, url: 'https://tryspice.xyz/mcp' },
        },
        provider: 'meta',
        schema_version: 1,
      })
      expect(museExecArgs({
        promptPath: '/tmp/prompt.txt',
        workspace: '/tmp/workspace',
        provider: 'echo',
      })).toEqual([
        'exec', '--yolo',
        '--prompt-file', '/tmp/prompt.txt',
        '--max-model-steps', '80',
        '--workspace', '/tmp/workspace',
        '--provider', 'echo',
      ])
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('launches muse exec on the echo provider', async () => {
    const muse = process.env.MUSE_BIN ?? 'muse'
    const previous = process.env.SPICE_DAILY_RESEARCH_MUSE_PROVIDER
    try {
      await access(join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'muse', 'auth.json'))
    } catch {
      return
    }
    try {
      process.env.SPICE_DAILY_RESEARCH_MUSE_PROVIDER = 'echo'
      process.env.MUSE_BIN = muse
      await museRun('reply with the single word pong', 'test-token')
    } catch (error) {
      if (String(error).includes('ENOENT')) return
      throw error
    } finally {
      if (previous === undefined) delete process.env.SPICE_DAILY_RESEARCH_MUSE_PROVIDER
      else process.env.SPICE_DAILY_RESEARCH_MUSE_PROVIDER = previous
    }
  })

  it('hands launcher facts to the agent without treating them as citations', () => {
    const suffix = unattendedPromptSuffix({
      briefId: 'recommendations-2026-09-11',
      market: { opensAt: '2026-09-16T13:30:00.000Z', state: 'after' },
      today: '2026-09-16',
    })
    expect(suffix).toContain('US market date: 2026-09-16')
    expect(suffix).toContain('named open 2026-09-16T13:30:00.000Z')
    expect(suffix).toContain('recommendations-2026-09-11')
    expect(suffix).toContain('not publishable evidence')
  })
})
