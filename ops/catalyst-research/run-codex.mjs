import { chromium } from '@playwright/test'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const [inputPath, artifactPath, runsPath] = process.argv.slice(2)
if (!inputPath || !artifactPath || !runsPath) {
  throw new Error('Usage: run-codex.mjs INPUT ARTIFACT RUNS_DIR')
}

const versionResult = spawnSync('codex', ['--version'], { encoding: 'utf8' })
const codexVersion = versionResult.stdout?.match(/codex-cli\s+\d+\.\d+\.\d+/)?.[0]
if (versionResult.status !== 0 || !codexVersion) {
  throw new Error('Catalyst research requires a working codex CLI that reports its version')
}

const operationDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(operationDir, '../..')
const schemaPath = path.join(operationDir, 'output-schema.json')
const model = 'gpt-5.6-sol'
const reasoningEffort = 'xhigh'
const input = JSON.parse(await readFile(inputPath, 'utf8'))
if (!Array.isArray(input.instruments)) throw new Error('Catalyst input is missing instruments')
await mkdir(runsPath, { recursive: true })

function positiveInteger(name, value, fallback) {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

const chunkSize = positiveInteger('SPICE_CATALYST_CHUNK_SIZE', process.env.SPICE_CATALYST_CHUNK_SIZE, 12)
const concurrency = positiveInteger('SPICE_CATALYST_CONCURRENCY', process.env.SPICE_CATALYST_CONCURRENCY, 2)
const selectedInstruments = input.instruments
if (!selectedInstruments.length) throw new Error('Catalyst run selected no instruments')

const now = new Date()
const today = new Intl.DateTimeFormat('en-CA', {
  day: '2-digit', month: '2-digit', timeZone: 'America/New_York', year: 'numeric',
}).format(now)
// The importer accepts a finding only when its date falls in [today, today + 180]
// measured from the same New York date (`catalystFromFinding` in
// src/server/catalyst-bootstrap.ts), and one out-of-window finding rejects the whole
// artifact. Deriving the horizon from the wall clock instead put the prompt's window a
// day past that whenever a run started after 20:00 New York, and moved the manifest
// across UTC midnight so a resume re-researched chunks it had already completed.
const horizonDate = new Date(`${today}T00:00:00Z`)
horizonDate.setUTCDate(horizonDate.getUTCDate() + 180)
const horizon = horizonDate.toISOString().slice(0, 10)
const chunks = []
for (let chunkStart = 0; chunkStart < selectedInstruments.length; chunkStart += chunkSize) {
  chunks.push(selectedInstruments.slice(chunkStart, chunkStart + chunkSize))
}
const manifest = {
  chunkSize,
  codexVersion,
  horizon,
  inputHash: createHash('sha256').update(JSON.stringify(selectedInstruments)).digest('hex'),
  model,
  reasoningEffort,
  symbols: selectedInstruments.map((instrument) => instrument.symbol),
  today,
}
const manifestPath = path.join(runsPath, 'manifest.json')
async function readOptionalFile(filePath) {
  try {
    return await readFile(filePath, 'utf8')
  } catch (cause) {
    if (cause?.code === 'ENOENT') return undefined
    throw cause
  }
}

async function readOptionalJson(filePath) {
  const contents = await readOptionalFile(filePath)
  return contents === undefined ? undefined : JSON.parse(contents)
}

/** A chunk killed mid-write is not an answer, so it is rerun rather than failing the day. */
async function readStoredChunk(filePath, index) {
  const contents = await readOptionalFile(filePath)
  if (contents === undefined) return undefined
  try {
    return JSON.parse(contents)
  } catch {
    process.stderr.write(`Rerunning unreadable catalyst chunk ${index + 1}/${chunks.length}\n`)
    return undefined
  }
}

const existingManifest = await readOptionalJson(manifestPath)
if (existingManifest && JSON.stringify(existingManifest) !== JSON.stringify(manifest)) {
  // Chunk files are keyed by position, so partial work for a different instrument
  // list would be reused for the wrong symbols. The daily timer resumes into one
  // directory per day, and the watchlist can change between an interrupted run and
  // its catch-up; park the stale files instead of failing the whole day.
  const staleDir = path.join(runsPath, `stale-${String(existingManifest.inputHash ?? 'unknown').slice(0, 12)}`)
  await mkdir(staleDir, { recursive: true })
  for (const name of await readdir(runsPath)) {
    if (/^(chunk-\d{3}\.jsonl?|manifest\.json)$/.test(name)) {
      await rename(path.join(runsPath, name), path.join(staleDir, name))
    }
  }
  process.stderr.write(`Catalyst input changed; moved the previous partial run to ${staleDir}\n`)
}
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

function prompt(instruments) {
  return `Refresh an official-source upcoming catalyst calendar for an options investor.

Use Codex's native live web search. Do not use Reddit, X, Twitter, other social posts, or secondary reporting as final evidence. Search each supplied instrument carefully. Secondary pages may help locate a source, but every returned sourceUrl must be the company investor-relations site or official newsroom, a regulator, clinical-trial registry, government page, or official event organizer. Follow leads until you find a direct dated source or conclude that no qualifying event is known.

Today in New York is ${today}. Return only material, scheduled, ticker-specific events from ${today} through ${horizon}. Exclude earnings, dividends, routine filings, past events, undated possibilities, analyst forecasts, rumors, and generic product roadmaps. An exact date must be stated by the source. Re-report an event that is still scheduled. Never infer that a similarly named security or company belongs to a ticker.

For every finding, echo symbol and instrumentName exactly from this input. Use the direct HTTPS page that establishes the date, not a search result page or home page. Keep the description factual and under 500 characters. Use unknown timing unless the source establishes pre-market, intraday, or after-hours. Return an empty findings array when the evidence bar is not met.

Every sourceUrl is fetched and read after you answer. A finding is discarded unless the page served at that URL contains the event date in its visible text, so cite the page that states the date itself, never a hub, calendar index, or search result that merely links to it.

An instrument with resolutionStatus unresolved has only a tastytrade watchlist symbol, not a verified instrument name. Research it only when an official source clearly establishes what that exact ticker represents; otherwise return no finding for it.

Instruments:\n${JSON.stringify(instruments)}`
}

// A cited page has to answer for itself. The runner fetches every sourceUrl with an
// ordinary HTTP client and keeps a finding only when the page it served contains the
// finding's date, recording where the bytes came from and the text around the match.
// Nothing the model says about its own browsing is evidence.
// Fifteen seconds is longer than any investor-relations page needs and short enough that
// one unresponsive host cannot stall a hundred-symbol run; five megabytes is past the
// largest IR page observed and bounds a hostile response; a hundred characters either
// side of the date is enough for a reader to see the claim in context and stays inside
// the importer's snippet bound.
const VERIFY_TIMEOUT_MS = 15_000
const VERIFY_MAX_BYTES = 5_000_000
const SNIPPET_RADIUS = 100
const DATE_PROXIMITY_CHARS = 60
const VERIFY_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36'

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

// Mirror of isoDateRenderings in src/domain/iso-date.ts. The importer re-derives the same
// set from the finding's date and re-checks the snippet, so that copy is authoritative and
// this one exists only so the runner can drop a finding before sending it. Keep them in step.
function dateRenderings(date) {
  const [year, month, day] = date.split('-').map(Number)
  if (!year || !month || !day) return []
  const monthName = MONTHS[month - 1]
  const short = monthName.slice(0, 3)
  return [
    date,
    `${monthName} ${day}, ${year}`,
    `${monthName} ${day} ${year}`,
    `${short} ${day}, ${year}`,
    `${short} ${day} ${year}`,
    `${day} ${monthName} ${year}`,
    `${day} ${short} ${year}`,
    `${String(day).padStart(2, '0')} ${monthName} ${year}`,
    `${month}/${day}/${year}`,
    `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}/${year}`,
  ]
}

function visibleText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

function dateSnippet(text, date) {
  const lowered = text.toLowerCase()
  for (const rendering of dateRenderings(date)) {
    const at = lowered.indexOf(rendering.toLowerCase())
    if (at === -1) continue
    return text.slice(Math.max(0, at - SNIPPET_RADIUS), at + rendering.length + SNIPPET_RADIUS)
  }
  // Ranges: see textMentionsIsoDate in src/domain/iso-date.ts, which the importer applies to
  // whatever snippet this returns. The snippet has to carry the year, or that check fails.
  const [year, month, day] = date.split('-').map(Number)
  const spelled = new RegExp(`\\b(?:${MONTHS[month - 1]}|${MONTHS[month - 1].slice(0, 3)})\\.?\\s+0?${day}\\b`, 'gi')
  for (const match of text.matchAll(spelled)) {
    const window = text.slice(match.index, match.index + DATE_PROXIMITY_CHARS)
    if (new RegExp(`\\b${year}\\b`).test(window)) {
      return text.slice(Math.max(0, match.index - SNIPPET_RADIUS), match.index + DATE_PROXIMITY_CHARS + SNIPPET_RADIUS)
    }
  }
  return undefined
}

async function readCapped(response) {
  const reader = response.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const parts = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    size += value.length
    if (size >= VERIFY_MAX_BYTES) {
      await reader.cancel()
      break
    }
  }
  return Buffer.concat(parts, Math.min(size, VERIFY_MAX_BYTES))
}

// Investor-relations hosts behind bot management answer a plain client with 403 however its
// headers are dressed, and others render their event dates client-side so the served HTML
// carries no date at all. Both refuse a citation that a person reading the page can see, so a
// failed plain fetch is retried in a real browser. It is the same deterministic evidence — a
// non-model client fetching the cited URL — just one that runs the page's own scripts.
// Five seconds past load is enough for those widgets to paint without waiting on the
// third-party beacons that keep an IR page's network busy indefinitely.
const RENDER_SETTLE_MS = 5_000
let sharedBrowser

async function renderedVerification(finding) {
  sharedBrowser ??= chromium.launch().catch((cause) => {
    process.stderr.write(`Browser verification unavailable: ${cause?.message ?? 'launch failed'}\n`)
    return undefined
  })
  const browser = await sharedBrowser
  if (!browser) return undefined
  const context = await browser.newContext({ userAgent: VERIFY_USER_AGENT })
  try {
    const page = await context.newPage()
    const response = await page.goto(finding.sourceUrl, { timeout: VERIFY_TIMEOUT_MS, waitUntil: 'load' })
    if (response?.status() !== 200) return undefined
    await page.waitForLoadState('networkidle', { timeout: RENDER_SETTLE_MS }).catch(() => undefined)
    const html = await page.content()
    const finalUrl = page.url()
    if (!finalUrl.startsWith('https://')) return undefined
    const snippet = dateSnippet(visibleText(html), finding.date)
    if (!snippet) return undefined
    return {
      contentSha256: createHash('sha256').update(html).digest('hex'),
      fetchedAt: new Date().toISOString(),
      finalUrl,
      httpStatus: 200,
      snippet,
      via: 'browser',
    }
  } catch {
    return undefined
  } finally {
    await context.close().catch(() => undefined)
  }
}

// A handful of investor-relations hosts refuse a plain client and a real browser alike,
// answering both with 403 from their bot management. Firecrawl reads those through its own
// proxies, so it is the last tier: a citation it recovers is still established by a fetch
// rather than by anything the model says, but the fetch was performed by a third party
// reporting what the URL served, so the record says so and the reader can weigh it.
// A minute is far longer than the tier's own pages need and bounds a scrape that stalls
// upstream; the tier only ever runs for findings the first two could not read.
const PROXY_TIMEOUT_MS = 60_000
let proxyAvailable

async function proxyIsAuthenticated() {
  proxyAvailable ??= new Promise((resolve) => {
    const probe = spawn('npx', ['firecrawl-cli', '--status'], {
      cwd: repoRoot, env: { ...process.env, FIRECRAWL_NO_TELEMETRY: '1' }, stdio: ['ignore', 'pipe', 'ignore'],
    })
    let output = ''
    probe.stdout.setEncoding('utf8')
    probe.stdout.on('data', (chunk) => { output += chunk })
    probe.once('error', () => resolve(false))
    probe.once('close', () => {
      const ready = output.includes('Authenticated')
      if (!ready) process.stderr.write('Proxy verification unavailable: firecrawl CLI is not authenticated\n')
      resolve(ready)
    })
  })
  return proxyAvailable
}

async function proxiedVerification(finding) {
  if (!await proxyIsAuthenticated()) return undefined
  const outputPath = path.join(runsPath, `proxy-${createHash('sha256').update(finding.sourceUrl).digest('hex').slice(0, 16)}.json`)
  const scraped = await new Promise((resolve) => {
    const child = spawn('npx', [
      'firecrawl-cli', 'scrape', finding.sourceUrl,
      // Without this the service answers from its own cache, which would make the evidence
      // "the proxy saw this text at some earlier time" rather than what the URL serves now.
      '--max-age', '0',
      '--format', 'rawHtml', '--json', '-o', outputPath,
    ], { cwd: repoRoot, env: { ...process.env, FIRECRAWL_NO_TELEMETRY: '1' }, stdio: 'ignore' })
    const timer = setTimeout(() => { child.kill(); resolve(false) }, PROXY_TIMEOUT_MS)
    child.once('error', () => { clearTimeout(timer); resolve(false) })
    child.once('close', (code) => { clearTimeout(timer); resolve(code === 0) })
  })
  if (!scraped) return undefined
  try {
    const payload = JSON.parse(await readFile(outputPath, 'utf8'))
    const finalUrl = payload.metadata?.sourceURL ?? payload.metadata?.url
    if (payload.metadata?.statusCode !== 200 || !finalUrl?.startsWith('https://')) return undefined
    const snippet = dateSnippet(visibleText(payload.rawHtml ?? ''), finding.date)
    if (!snippet) return undefined
    return {
      contentSha256: createHash('sha256').update(payload.rawHtml).digest('hex'),
      fetchedAt: new Date().toISOString(),
      finalUrl,
      httpStatus: 200,
      snippet,
      via: 'proxy',
    }
  } catch {
    return undefined
  }
}

async function verifyFinding(finding) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS)
  try {
    const response = await fetch(finding.sourceUrl, {
      headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': VERIFY_USER_AGENT },
      redirect: 'follow',
      signal: controller.signal,
    })
    if (response.status !== 200) return { reason: `http-${response.status}` }
    if (!response.url.startsWith('https://')) return { reason: 'insecure-final-url' }
    const body = await readCapped(response)
    const snippet = dateSnippet(visibleText(new TextDecoder().decode(body)), finding.date)
    if (!snippet) return { reason: 'date-absent' }
    return {
      verification: {
        contentSha256: createHash('sha256').update(body).digest('hex'),
        fetchedAt: new Date().toISOString(),
        finalUrl: response.url,
        httpStatus: 200,
        snippet,
        via: 'fetch',
      },
    }
  } catch (cause) {
    return { reason: cause?.name === 'AbortError' ? 'timeout' : 'fetch-failed' }
  } finally {
    clearTimeout(timer)
  }
}

// Sequential inside a chunk: chunks already run concurrently, and one page at a time per
// chunk keeps the run from arriving at a provider as a burst.
async function verifyFindings(findings, index) {
  const verified = []
  const rejected = []
  for (const finding of findings) {
    const outcome = await verifyFinding(finding)
    if (outcome.verification) {
      verified.push({ ...finding, verification: outcome.verification })
      continue
    }
    // The label records that the page was also opened in a browser, so a rejection is never
    // read as though only the cheap attempt was made.
    const recovered = await renderedVerification(finding) ?? await proxiedVerification(finding)
    if (recovered) verified.push({ ...finding, verification: recovered })
    else rejected.push(`${finding.symbol}:${outcome.reason}+rendered+proxied`)
  }
  process.stderr.write(
    `Chunk ${index + 1}/${chunks.length} verified ${verified.length}/${findings.length}`
    + `${rejected.length ? ` (rejected ${rejected.join(', ')})` : ''}\n`,
  )
  return { rejected: rejected.length, verified }
}

async function runChunk(instruments, index) {
  const finalPath = path.join(runsPath, `chunk-${String(index + 1).padStart(3, '0')}.json`)
  const transcriptPath = path.join(runsPath, `chunk-${String(index + 1).padStart(3, '0')}.jsonl`)
  const completed = await readStoredChunk(finalPath, index)
  if (completed !== undefined) {
    if (!Array.isArray(completed.findings)) {
      throw new Error(`Stored catalyst chunk ${index + 1} returned no findings`)
    }
    // Codex output is reused, but the pages are fetched again: provenance is only worth
    // what it was worth at the moment the artifact was built.
    process.stderr.write(`Reusing catalyst chunk ${index + 1}/${chunks.length}\n`)
    return verifyFindings(completed.findings, index)
  }
  process.stderr.write(`Starting catalyst chunk ${index + 1}/${chunks.length}\n`)
  const child = spawn('codex', [
    '--search',
    'exec',
    '--ephemeral',
    '--ignore-user-config',
    '--model', model,
    '--config', `model_reasoning_effort="${reasoningEffort}"`,
    '--sandbox', 'read-only',
    '--json',
    '--output-schema', schemaPath,
    '--output-last-message', finalPath,
    prompt(instruments),
  ], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'inherit'] })
  let transcript = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { transcript += chunk })
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  // Kept as the record of what the model actually did, which is how the open_page
  // regression was found. It is a debugging artifact and no longer evidence of anything.
  await writeFile(transcriptPath, transcript)
  if (exitCode !== 0) throw new Error(`Codex catalyst chunk ${index + 1} failed with exit ${exitCode}`)
  const output = JSON.parse(await readFile(finalPath, 'utf8'))
  if (!Array.isArray(output.findings)) throw new Error(`Codex catalyst chunk ${index + 1} returned no findings`)
  return verifyFindings(output.findings, index)
}

const findings = []
let rejectedCount = 0
const chunkResults = Array.from({ length: chunks.length })
let nextChunk = 0
async function runWorker() {
  for (;;) {
    const index = nextChunk
    nextChunk += 1
    if (index >= chunks.length) return
    chunkResults[index] = await runChunk(chunks[index], index)
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, () => runWorker()))
for (const chunk of chunkResults) {
  findings.push(...chunk.verified)
  rejectedCount += chunk.rejected
}
process.stderr.write(`Verified ${findings.length} findings; ${rejectedCount} rejected\n`)
await (await sharedBrowser)?.close().catch(() => undefined)

await writeFile(artifactPath, `${JSON.stringify({
  codexVersion,
  findings,
  model,
  reasoningEffort,
  rejectedCount,
  researchedSymbols: selectedInstruments.map((instrument) => instrument.symbol),
  runId: randomUUID(),
}, null, 2)}\n`)
