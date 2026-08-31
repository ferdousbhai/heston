import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const [inputPath, artifactPath, runsPath] = process.argv.slice(2)
if (!inputPath || !artifactPath || !runsPath) {
  throw new Error('Usage: run-codex.mjs INPUT ARTIFACT RUNS_DIR')
}

const LAST_KNOWN_AMBIGUOUS_TRANSCRIPT_VERSION = [0, 148, 0]
const versionResult = spawnSync('codex', ['--version'], { encoding: 'utf8' })
const versionMatch = versionResult.stdout?.match(/codex-cli\s+(\d+)\.(\d+)\.(\d+)/)
const installedVersion = versionMatch?.slice(1).map(Number)
const codexVersion = versionMatch?.[0]
const versionOrder = installedVersion
  ? installedVersion[0] - LAST_KNOWN_AMBIGUOUS_TRANSCRIPT_VERSION[0]
    || installedVersion[1] - LAST_KNOWN_AMBIGUOUS_TRANSCRIPT_VERSION[1]
    || installedVersion[2] - LAST_KNOWN_AMBIGUOUS_TRANSCRIPT_VERSION[2]
  : -1
if (versionResult.status !== 0 || versionOrder <= 0) {
  const found = versionMatch?.[0] ?? 'unknown Codex version'
  throw new Error(
    `Catalyst research requires a codex-cli release newer than 0.148.0 that emits structured open_page transcript actions; found ${found}`,
  )
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

Immediately before your final response, open every sourceUrl directly by its exact HTTPS URL. The importer rejects any finding whose page-open event is absent from the Codex transcript.

An instrument with resolutionStatus unresolved has only a tastytrade watchlist symbol, not a verified instrument name. Research it only when an official source clearly establishes what that exact ticker represents; otherwise return no finding for it.

Instruments:\n${JSON.stringify(instruments)}`
}

function openPageTranscript(transcript) {
  return transcript.split('\n').filter((line) => {
    if (!line) return false
    const event = JSON.parse(line)
    return event?.type === 'item.completed'
      && event.item?.type === 'web_search'
      && event.item.action?.type === 'open_page'
  }).join('\n')
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
      process.stderr.write(`Reusing catalyst chunk ${index + 1}/${chunks.length}\n`)
      return { findings: completed.findings, transcript: existingTranscript }
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
  return { findings: output.findings, transcript }
}

const findings = []
const openPageTranscripts = []
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
  findings.push(...chunk.findings)
  openPageTranscripts.push(openPageTranscript(chunk.transcript))
}

await writeFile(artifactPath, `${JSON.stringify({
  codexVersion,
  findings,
  model,
  openPageTranscripts,
  reasoningEffort,
  researchedSymbols: selectedInstruments.map((instrument) => instrument.symbol),
  runId: randomUUID(),
}, null, 2)}\n`)
