#!/usr/bin/env node
/**
 * Owner-machine market-open brief: run `daily_research` when today's US session has no brief.
 * Connects to Spice with the keyring token and no broker header, so account tools refuse.
 * The Worker never produces a brief. If this laptop is asleep, the site keeps the last one.
 */
import { execFile, spawn } from 'node:child_process'
import { access, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { z } from 'zod'

const MarketOpenSchema = z.iso.datetime({ offset: true }).optional()
const MarketSessionResponseSchema = z.object({
  marketState: z.enum(['open', 'closed', 'pre', 'after', 'unknown']),
  marketOpensAt: MarketOpenSchema,
})

const execFileAsync = promisify(execFile)
const MCP = process.env.SPICE_MCP_URL ?? 'https://tryspice.xyz/mcp'
const SNAPSHOT = process.env.SPICE_PUBLIC_SNAPSHOT_URL
  ?? 'https://tryspice.xyz/api/public-snapshot?fields=session'
const GROK = process.env.GROK_BIN ?? 'grok'
const MAX_TURNS = Number(process.env.SPICE_DAILY_RESEARCH_MAX_TURNS ?? 80)

/** Live session, or catch-up after today's named open has already rung. Holiday/weekend: skip. */
export function shouldRunForMarket({ state, opensAt }, now = new Date()) {
  if (state === 'open' || state === 'pre') return true
  const parsed = MarketOpenSchema.safeParse(opensAt)
  if (!parsed.success || parsed.data === undefined) return false
  const open = Date.parse(parsed.data)
  if (!Number.isFinite(open)) return false
  return marketDate(new Date(parsed.data)) === marketDate(now) && now.getTime() >= open
}

export function marketDate(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now).map((part) => [part.type, part.value]),
  )
  return `${parts.year}-${parts.month}-${parts.day}`
}

export function alreadyPublishedToday(briefId, today) {
  return briefId === `recommendations-${today}`
}

export function unattendedPromptSuffix({ briefId, market, today }) {
  return `This run is unattended. Do not place, cancel, or reconcile brokerage orders, and do not remove watchlist symbols.

Launcher facts (not publishable evidence; still call \`read_daily_recommendations\` as the recipe requires):
- US market date: ${today}
- Equity session: ${market.state}${market.opensAt ? `; named open ${market.opensAt}` : ''}
- Standing brief id: ${briefId ?? 'none'}`
}

async function requireGrokAuth() {
  const home = process.env.GROK_HOME ?? join(homedir(), '.grok')
  try {
    await access(join(home, 'auth.json'))
  } catch {
    throw new Error('SpiceDailyResearch:grok-auth-missing')
  }
  return join(home, 'auth.json')
}

async function spiceToken() {
  try {
    const { stdout } = await execFileAsync('secret-tool', ['lookup', 'service', 'spice', 'key', 'mcp-token'], {
      timeout: 5_000,
    })
    const token = stdout.trim()
    if (!token) throw new Error('SpiceDailyResearch:mcp-token-missing')
    return token
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('SpiceDailyResearch:')) throw error
    throw new Error('SpiceDailyResearch:mcp-token-missing')
  }
}

function parseSseOrJson(raw) {
  if (!raw.trim()) return {}
  if (raw.trimStart().startsWith('{') || raw.trimStart().startsWith('[')) return JSON.parse(raw)
  let last
  for (const line of raw.split('\n')) {
    if (line.startsWith('data:')) {
      const payload = line.slice(5).trim()
      if (payload && payload !== '[DONE]') last = JSON.parse(payload)
    }
  }
  if (last === undefined) throw new Error(`SpiceDailyResearch:unparseable-mcp:${raw.slice(0, 200)}`)
  return last
}

async function rpc(method, params, session, token, notif = false, timeoutMs = 60_000) {
  const body = { jsonrpc: '2.0', method }
  if (!notif) body.id = 1
  if (params !== undefined) body.params = params
  const headers = {
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'spice-daily-research/1',
    'mcp-protocol-version': '2025-03-26',
  }
  if (session) headers['mcp-session-id'] = session
  let response
  try {
    response = await fetch(MCP, {
      body: JSON.stringify(body),
      headers,
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new Error(`SpiceDailyResearch:mcp-unreachable:${error instanceof Error ? error.name : 'unknown'}`)
  }
  const raw = await response.text()
  if (!response.ok) throw new Error(`SpiceDailyResearch:mcp-${response.status}`)
  if (notif && !raw.trim()) return { session: response.headers.get('mcp-session-id') ?? session, parsed: {} }
  return { session: response.headers.get('mcp-session-id') ?? session, parsed: parseSseOrJson(raw) }
}

function toolText(parsed) {
  if (parsed.error) throw new Error(`SpiceDailyResearch:rpc:${JSON.stringify(parsed.error)}`)
  const texts = (parsed.result?.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
  const joined = texts.join('\n')
  try {
    return JSON.parse(joined)
  } catch {
    return joined
  }
}

export async function readMarketState() {
  const response = await fetch(SNAPSHOT, { method: 'GET', signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`SpiceDailyResearch:snapshot-${response.status}`)
  const parsed = MarketSessionResponseSchema.safeParse(await response.json())
  if (!parsed.success) throw new Error('SpiceDailyResearch:invalid-market-session')
  return { opensAt: parsed.data.marketOpensAt, state: parsed.data.marketState }
}

async function grokRun(prompt, token) {
  const directory = await mkdtemp(join(tmpdir(), 'spice-daily-research-'))
  const promptPath = join(directory, 'prompt.txt')
  const grokHome = join(directory, 'grok-home')
  await mkdir(grokHome)
  await copyFile(await requireGrokAuth(), join(grokHome, 'auth.json'))
  await writeFile(
    join(grokHome, 'config.toml'),
    `[mcp_servers.spice]\nurl = "${MCP}"\ntype = "http"\nbearer_token_env_var = "SPICE_MCP_TOKEN"\n`,
  )
  await writeFile(promptPath, prompt)
  try {
    const child = spawn(GROK, [
      '--prompt-file', promptPath,
      '--always-approve',
      '--max-turns', String(MAX_TURNS),
      '--output-format', 'plain',
      '--disallowed-tools', 'Agent',
    ], {
      env: { ...process.env, GROK_HOME: grokHome, SPICE_MCP_TOKEN: token },
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('exit', (exitCode, signal) => {
        if (signal) reject(new Error(`SpiceDailyResearch:grok-signal:${signal}`))
        else resolve(exitCode ?? 1)
      })
    })
    if (code !== 0) throw new Error(`SpiceDailyResearch:grok-exit:${code}`)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}

async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write('Usage: daily-research.mjs [--check]\n')
    return
  }
  const today = marketDate()
  const market = await readMarketState()
  if (!shouldRunForMarket(market)) {
    process.stdout.write(`SpiceDailyResearch: market ${market.state}, skip ${today}\n`)
    return
  }

  const token = await spiceToken()
  const { session, parsed: init } = await rpc('initialize', {
    capabilities: {},
    clientInfo: { name: 'spice-daily-research', version: '0.1' },
    protocolVersion: '2025-03-26',
  }, undefined, token, false, 5_000)
  if (init.error) throw new Error(`SpiceDailyResearch:initialize:${JSON.stringify(init.error)}`)
  await rpc('notifications/initialized', {}, session, token, true)

  const brief = toolText((await rpc('tools/call', {
    arguments: {},
    name: 'read_daily_recommendations',
  }, session, token)).parsed)
  const briefId = brief?.dailyRecommendations?.id
  if (alreadyPublishedToday(briefId, today)) {
    process.stdout.write(`SpiceDailyResearch: already have ${briefId}\n`)
    return
  }

  if (process.argv.includes('--check')) {
    process.stdout.write(`SpiceDailyResearch: would run for ${today} (standing ${briefId ?? 'none'})\n`)
    return
  }

  const promptResult = await rpc('prompts/get', { name: 'daily_research' }, session, token)
  const messages = promptResult.parsed.result?.messages ?? []
  const recipe = messages.map((message) => message.content?.text ?? '').filter(Boolean).join('\n\n')
  if (!recipe) throw new Error('SpiceDailyResearch:missing-daily-research-prompt')
  const prompt = `${recipe.trim()}

${unattendedPromptSuffix({ briefId, market, today })}`
  process.stdout.write(`SpiceDailyResearch: running for ${today} (standing ${briefId ?? 'none'})\n`)
  await grokRun(prompt, token)
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'SpiceDailyResearch:unknown'}\n`)
    process.exit(1)
  })
}
