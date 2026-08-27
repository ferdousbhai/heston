import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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
const input = JSON.parse(await readFile(inputPath, 'utf8'))
if (!Array.isArray(input.instruments)) throw new Error('Catalyst input is missing instruments')
await mkdir(runsPath, { recursive: true })

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

const start = Math.max(0, Number(process.env.SPICE_CATALYST_START ?? 0) || 0)
const limit = positiveInteger(process.env.SPICE_CATALYST_LIMIT, input.instruments.length)
const chunkSize = positiveInteger(process.env.SPICE_CATALYST_CHUNK_SIZE, 12)
const concurrency = positiveInteger(process.env.SPICE_CATALYST_CONCURRENCY, 2)
const selectedInstruments = input.instruments.slice(start, start + limit)
if (!selectedInstruments.length) throw new Error('Catalyst run selected no instruments')

const now = new Date()
const today = new Intl.DateTimeFormat('en-CA', {
  day: '2-digit', month: '2-digit', timeZone: 'America/New_York', year: 'numeric',
}).format(now)
const horizon = new Date(now.getTime() + 180 * 86_400_000).toISOString().slice(0, 10)
const chunks = []
for (let chunkStart = 0; chunkStart < selectedInstruments.length; chunkStart += chunkSize) {
  chunks.push(selectedInstruments.slice(chunkStart, chunkStart + chunkSize))
}
const manifest = {
  chunkSize,
  horizon,
  inputHash: createHash('sha256').update(JSON.stringify(selectedInstruments)).digest('hex'),
  symbols: selectedInstruments.map((instrument) => instrument.symbol),
  today,
}
const manifestPath = path.join(runsPath, 'manifest.json')
try {
  const existing = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (JSON.stringify(existing) !== JSON.stringify(manifest)) throw new Error('Catalyst resume manifest does not match')
} catch (cause) {
  if (cause instanceof Error && cause.message === 'Catalyst resume manifest does not match') throw cause
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

function prompt(instruments) {
  return `You are doing a one-time bootstrap of an upcoming catalyst calendar for an options investor.

Use Codex's native live web search. Do not use Reddit, X, Twitter, or other social posts as evidence in this run. Search each supplied instrument carefully, preferring its investor-relations site, official newsroom, regulator records, clinical-trial records, government pages, and official event or conference organizers. Follow second-order leads until you either find a direct dated source or conclude that no qualifying event is known.

Today in New York is ${today}. Return only material, scheduled, ticker-specific events from ${today} through ${horizon}. Exclude earnings, dividends, routine filings, past events, undated possibilities, analyst forecasts, rumors, and generic product roadmaps. An exact date must be stated by the source. Use reputable secondary reporting only when no direct source is available. Every finding in this manual run is stored as estimated. Never infer that a similarly named security or company belongs to a ticker.

For every finding, echo symbol and instrumentName exactly from this input. Use the direct HTTPS page that establishes the date, not a search result page or home page. Keep the description factual and under 500 characters. Use unknown timing unless the source establishes pre-market, intraday, or after-hours. Return an empty findings array when the evidence bar is not met.

Immediately before your final response, open every sourceUrl directly by its exact HTTPS URL. The importer rejects any finding whose page-open event is absent from the Codex transcript.

An instrument with resolutionStatus unresolved has only a tastytrade watchlist symbol, not a verified instrument name. Research it only when an official source clearly establishes what that exact ticker represents; otherwise return no finding for it.

Instruments:\n${JSON.stringify(instruments)}`
}

async function runChunk(instruments, index) {
  const finalPath = path.join(runsPath, `chunk-${String(index + 1).padStart(3, '0')}.json`)
  const transcriptPath = path.join(runsPath, `chunk-${String(index + 1).padStart(3, '0')}.jsonl`)
  try {
    const [completed, transcript] = await Promise.all([
      readFile(finalPath, 'utf8').then(JSON.parse),
      readFile(transcriptPath, 'utf8'),
    ])
    if (Array.isArray(completed.findings)) {
      process.stderr.write(`Reusing catalyst chunk ${index + 1}/${chunks.length}\n`)
      return { findings: completed.findings, transcript }
    }
  } catch {
    // Missing or incomplete chunks are safe to rerun because no D1 write happens here.
  }
  process.stderr.write(`Starting catalyst chunk ${index + 1}/${chunks.length}\n`)
  const child = spawn('codex', [
    '--search',
    'exec',
    '--ephemeral',
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
const transcripts = []
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
  transcripts.push(chunk.transcript)
}

await writeFile(artifactPath, `${JSON.stringify({
  findings,
  generatedAt: now.toISOString(),
  researchedSymbols: selectedInstruments.map((instrument) => instrument.symbol),
  runId: randomUUID(),
  transcripts,
}, null, 2)}\n`)
