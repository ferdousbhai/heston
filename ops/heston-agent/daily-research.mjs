#!/usr/bin/env node
/**
 * Owner-machine market-open brief: run `daily_research` when today's US session has no brief.
 * Connects to Heston with the keyring token and no broker header, so account tools refuse.
 * The Worker never produces a brief. If this laptop is asleep, the site keeps the last one.
 */
import { execFile, spawn } from 'node:child_process'
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
const MCP = process.env.HESTON_MCP_URL ?? 'https://heston.io/mcp'
const SNAPSHOT = process.env.HESTON_PUBLIC_SNAPSHOT_URL
  ?? 'https://heston.io/api/public-snapshot?fields=session'
const GROK = process.env.GROK_BIN ?? 'grok'
const MUSE = process.env.MUSE_BIN ?? 'muse'
const MAX_TURNS = Number(process.env.HESTON_DAILY_RESEARCH_MAX_TURNS ?? 80)
/**
 * Below this fraction of Grok's binding window left, the run goes to Muse instead.
 * A product policy, not a measurement: Grok is the primary runner and Muse the spare.
 */
const GROK_MIN_FRACTION = Number(process.env.HESTON_DAILY_RESEARCH_GROK_MIN_FRACTION ?? 0.05)
/**
 * The tray's collectors refresh on the order of minutes; a record older than this
 * means that pipeline is down, so its limits are unknown rather than zero.
 */
const LIMIT_RECORD_MAX_AGE_MS = 60 * 60 * 1_000

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

const UsageRecordSchema = z.object({
  limits: z.array(z.object({
    percent: z.number(),
    resetsAt: z.string().optional(),
  })).optional(),
  updatedAt: z.string().optional(),
})

export function grokUsageRecordPath() {
  const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state')
  return join(stateHome, 'omarchy', 'agents', 'usage', 'grok.json')
}

/**
 * Fraction of Grok's binding window left, on the tray's own convention: each limit's
 * `percent` is fullness (fraction consumed), and the fullest open window binds, since
 * that is what stops the next prompt. Unknown when no usable window remains.
 */
function remainingFromUsage(data, now) {
  let fullest
  for (const entry of data.limits ?? []) {
    if (!Number.isFinite(entry.percent) || entry.percent < 0) continue
    if (entry.resetsAt) {
      const reset = Date.parse(entry.resetsAt)
      if (Number.isFinite(reset) && reset <= now.getTime()) continue
    }
    fullest = fullest === undefined ? entry.percent : Math.max(fullest, entry.percent)
  }
  if (fullest === undefined) return undefined
  return Math.max(0, 1 - Math.min(fullest, 1))
}

export function grokLimitRemaining(record, now = new Date()) {
  const parsed = UsageRecordSchema.safeParse(record)
  if (!parsed.success) return undefined
  return remainingFromUsage(parsed.data, now)
}

/** The tray's Grok limits, or undefined when the record is missing, stale, or invalid. */
export async function readGrokLimitRemaining(recordPath = grokUsageRecordPath(), now = new Date()) {
  let raw
  try {
    raw = await readFile(recordPath, 'utf8')
  } catch {
    return undefined
  }
  let record
  try {
    record = JSON.parse(raw)
  } catch {
    return undefined
  }
  const parsed = UsageRecordSchema.safeParse(record)
  if (!parsed.success) return undefined
  const updatedAt = Date.parse(parsed.data.updatedAt ?? '')
  if (Number.isFinite(updatedAt) && now.getTime() - updatedAt > LIMIT_RECORD_MAX_AGE_MS) return undefined
  return remainingFromUsage(parsed.data, now)
}

async function requireReadable(path, error) {
  try {
    await access(path)
  } catch {
    throw new Error(error)
  }
  return path
}

async function requireGrokAuth() {
  const home = process.env.GROK_HOME ?? join(homedir(), '.grok')
  return requireReadable(join(home, 'auth.json'), 'HestonDailyResearch:grok-auth-missing')
}

async function hestonToken() {
  try {
    const { stdout } = await execFileAsync('secret-tool', ['lookup', 'service', 'heston', 'key', 'mcp-token'], {
      timeout: 5_000,
    })
    const token = stdout.trim()
    if (!token) throw new Error('HestonDailyResearch:mcp-token-missing')
    return token
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('HestonDailyResearch:')) throw error
    throw new Error('HestonDailyResearch:mcp-token-missing')
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
  if (last === undefined) throw new Error(`HestonDailyResearch:unparseable-mcp:${raw.slice(0, 200)}`)
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
    'User-Agent': 'heston-daily-research/1',
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
    throw new Error(`HestonDailyResearch:mcp-unreachable:${error instanceof Error ? error.name : 'unknown'}`)
  }
  const raw = await response.text()
  if (!response.ok) throw new Error(`HestonDailyResearch:mcp-${response.status}`)
  if (notif && !raw.trim()) return { session: response.headers.get('mcp-session-id') ?? session, parsed: {} }
  return { session: response.headers.get('mcp-session-id') ?? session, parsed: parseSseOrJson(raw) }
}

function toolText(parsed) {
  if (parsed.error) throw new Error(`HestonDailyResearch:rpc:${JSON.stringify(parsed.error)}`)
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
  if (!response.ok) throw new Error(`HestonDailyResearch:snapshot-${response.status}`)
  const parsed = MarketSessionResponseSchema.safeParse(await response.json())
  if (!parsed.success) throw new Error('HestonDailyResearch:invalid-market-session')
  return { opensAt: parsed.data.marketOpensAt, state: parsed.data.marketState }
}

function waitForExit(child, name) {
  return new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', (exitCode, signal) => {
      if (signal) reject(new Error(`HestonDailyResearch:${name}-signal:${signal}`))
      else resolve(exitCode ?? 1)
    })
  })
}

async function runIsolated(name, setup) {
  const directory = await mkdtemp(join(tmpdir(), 'heston-daily-research-'))
  try {
    const launched = await setup(directory)
    const child = spawn(launched.bin, launched.args, {
      cwd: launched.cwd ?? directory,
      env: launched.env,
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    const code = await waitForExit(child, name)
    if (code !== 0) throw new Error(`HestonDailyResearch:${name}-exit:${code}`)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}

async function grokRun(prompt, token) {
  await runIsolated('grok', async (directory) => {
    const promptPath = join(directory, 'prompt.txt')
    const grokHome = join(directory, 'grok-home')
    await mkdir(grokHome)
    await copyFile(await requireGrokAuth(), join(grokHome, 'auth.json'))
    await writeFile(
      join(grokHome, 'config.toml'),
      `[mcp_servers.heston]\nurl = "${MCP}"\ntype = "http"\nbearer_token_env_var = "HESTON_MCP_TOKEN"\n`,
    )
    await writeFile(promptPath, prompt)
    return {
      args: [
        '--prompt-file', promptPath,
        '--always-approve',
        '--max-turns', String(MAX_TURNS),
        '--output-format', 'plain',
        '--disallowed-tools', 'Agent',
      ],
      bin: GROK,
      env: { ...process.env, GROK_HOME: grokHome, HESTON_MCP_TOKEN: token },
    }
  })
}

function museConfigHome() {
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
}

export function museExecArgs({ promptPath, workspace, provider, maxTurns = MAX_TURNS }) {
  const args = [
    'exec', '--yolo',
    '--prompt-file', promptPath,
    '--max-model-steps', String(maxTurns),
    '--workspace', workspace,
  ]
  if (provider) args.push('--provider', provider)
  return args
}

/** Member provider/model only. MCP servers are replaced so this run cannot inherit a broker. */
export async function isolatedMuseSettings(
  token,
  sourcePath = join(museConfigHome(), 'muse', 'settings.json'),
) {
  let model
  let provider
  try {
    const parsed = z.object({
      model: z.string().min(1).optional(),
      provider: z.string().min(1).optional(),
    }).passthrough().safeParse(JSON.parse(await readFile(sourcePath, 'utf8')))
    if (parsed.success) {
      model = parsed.data.model
      provider = parsed.data.provider
    }
  } catch {
    // Muse CLI defaults still launch without a member settings file.
  }
  const settings = {
    schema_version: 1,
    mcpServers: {
      heston: { headers: { Authorization: `Bearer ${token}` }, url: MCP },
    },
  }
  if (provider) settings.provider = provider
  if (model) settings.model = model
  return settings
}

export async function museRun(prompt, token) {
  await runIsolated('muse', async (directory) => {
    const promptPath = join(directory, 'prompt.txt')
    const configHome = join(directory, 'muse-home')
    await mkdir(join(configHome, 'muse'), { recursive: true })
    await requireReadable(join(museConfigHome(), 'muse', 'auth.json'), 'HestonDailyResearch:muse-auth-missing')
    await copyFile(join(museConfigHome(), 'muse', 'auth.json'), join(configHome, 'muse', 'auth.json'))
    await writeFile(
      join(configHome, 'muse', 'settings.json'),
      JSON.stringify(await isolatedMuseSettings(token)),
      { mode: 0o600 },
    )
    await writeFile(promptPath, prompt)
    return {
      args: museExecArgs({
        promptPath,
        workspace: directory,
        provider: process.env.HESTON_DAILY_RESEARCH_MUSE_PROVIDER || undefined,
      }),
      bin: MUSE,
      cwd: directory,
      env: { ...process.env, XDG_CONFIG_HOME: configHome },
    }
  })
}

/**
 * Grok is the primary runner; Muse is the spare. A Grok failure never fails the
 * run while the spare is still untried — the brief matters more than which agent
 * wrote it.
 */
export async function runResearchAgent(prompt, token, runners = { grok: grokRun, muse: museRun }, skipGrok = false) {
  if (!skipGrok) {
    try {
      await runners.grok(prompt, token)
      return 'grok'
    } catch (error) {
      process.stderr.write(
        `HestonDailyResearch:grok-unavailable:${error instanceof Error ? error.message : 'unknown'}\n`,
      )
    }
  }
  await runners.muse(prompt, token)
  return 'muse'
}

async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write('Usage: daily-research.mjs [--check]\n')
    return
  }
  const today = marketDate()
  const market = await readMarketState()
  if (!shouldRunForMarket(market)) {
    process.stdout.write(`HestonDailyResearch: market ${market.state}, skip ${today}\n`)
    return
  }

  const token = await hestonToken()
  const { session, parsed: init } = await rpc('initialize', {
    capabilities: {},
    clientInfo: { name: 'heston-daily-research', version: '0.1' },
    protocolVersion: '2025-03-26',
  }, undefined, token, false, 5_000)
  if (init.error) throw new Error(`HestonDailyResearch:initialize:${JSON.stringify(init.error)}`)
  await rpc('notifications/initialized', {}, session, token, true)

  const brief = toolText((await rpc('tools/call', {
    arguments: {},
    name: 'read_daily_recommendations',
  }, session, token)).parsed)
  const briefId = brief?.dailyRecommendations?.id
  if (alreadyPublishedToday(briefId, today)) {
    process.stdout.write(`HestonDailyResearch: already have ${briefId}\n`)
    return
  }

  if (process.argv.includes('--check')) {
    process.stdout.write(`HestonDailyResearch: would run for ${today} (standing ${briefId ?? 'none'})\n`)
    return
  }

  const promptResult = await rpc('prompts/get', { name: 'daily_research' }, session, token)
  const messages = promptResult.parsed.result?.messages ?? []
  const recipe = messages.map((message) => message.content?.text ?? '').filter(Boolean).join('\n\n')
  if (!recipe) throw new Error('HestonDailyResearch:missing-daily-research-prompt')
  const prompt = `${recipe.trim()}

${unattendedPromptSuffix({ briefId, market, today })}`
  process.stdout.write(`HestonDailyResearch: running for ${today} (standing ${briefId ?? 'none'})\n`)
  const remaining = await readGrokLimitRemaining()
  const skipGrok = remaining !== undefined && remaining < GROK_MIN_FRACTION
  if (skipGrok) {
    process.stdout.write(
      `HestonDailyResearch: grok ${(remaining * 100).toFixed(1)}% left, running on muse\n`,
    )
  }
  await runResearchAgent(prompt, token, undefined, skipGrok)
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'HestonDailyResearch:unknown'}\n`)
    process.exit(1)
  })
}
