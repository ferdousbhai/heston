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
  if (!reader) return new Uint8Array()
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
  const body = new Uint8Array(size)
  let offset = 0
  for (const part of parts) {
    body.set(part.subarray(0, Math.min(part.length, size - offset)), offset)
    offset += part.length
    if (offset >= size) break
  }
  return body
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
    if (outcome.verification) verified.push({ ...finding, verification: outcome.verification })
    else rejected.push(`${finding.symbol}:${outcome.reason}`)
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
  const [completed, existingTranscript] = await Promise.all([
    readOptionalJson(finalPath),
    readOptionalFile(transcriptPath),
  ])
  if (completed !== undefined && existingTranscript !== undefined) {
    if (Array.isArray(completed.findings)) {
      // Codex output is reused, but the pages are fetched again: provenance is only worth
      // what it was worth at the moment the artifact was built.
      process.stderr.write(`Reusing catalyst chunk ${index + 1}/${chunks.length}\n`)
      return verifyFindings(completed.findings, index)
    }
    throw new Error(`Stored catalyst chunk ${index + 1} returned no findings`)
  }
  if (completed !== undefined || existingTranscript !== undefined) {
    // A process can stop between writing its transcript and structured response.
    // Neither file has reached D1, so rerunning this incomplete pair is safe.
    process.stderr.write(`Rerunning incomplete catalyst chunk ${index + 1}/${chunks.length}\n`)
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

await writeFile(artifactPath, `${JSON.stringify({
  codexVersion,
  findings,
  model,
  reasoningEffort,
  rejectedCount,
  researchedSymbols: selectedInstruments.map((instrument) => instrument.symbol),
  runId: randomUUID(),
}, null, 2)}\n`)
