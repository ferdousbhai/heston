// CPU-profile the client boot up to the first table row and rank self time by function.
//   node tools/perf/profile.mjs <url> <snapshot.json> [throttle]
import { readFile } from 'node:fs/promises'
import { chromium } from '@playwright/test'
const [url, snapshotPath, throttleArg] = process.argv.slice(2)
const body = await readFile(snapshotPath, 'utf8')
const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await context.newPage()
const cdp = await context.newCDPSession(page)
if (throttleArg === 'throttle') await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
const mockJson = (pattern, delayMs, payload) => page.route(pattern, async (route) => {
  await new Promise((done) => setTimeout(done, delayMs))
  await route.fulfill({ contentType: 'application/json', body: payload })
})
await mockJson('**/api/viewer', 120, JSON.stringify({ user: null }))
await mockJson('**/api/public-snapshot*', 150, body)
await cdp.send('Profiler.enable')
await cdp.send('Profiler.setSamplingInterval', { interval: 250 })
await cdp.send('Profiler.start')
const t0 = Date.now()
await page.goto(url, { waitUntil: 'commit' })
await page.locator('.premium-data-table tbody tr').first().waitFor({ state: 'visible', timeout: 90_000 })
const firstRow = Date.now() - t0
const { profile } = await cdp.send('Profiler.stop')
await browser.close()
const nodeById = new Map(profile.nodes.map((node) => [node.id, node]))
const selfTime = new Map()
const byFile = new Map()
for (let i = 0; i < profile.samples.length; i++) {
  const frame = nodeById.get(profile.samples[i]).callFrame
  const source = frame.url.replace(/^.*\/(node_modules|src)\//, '$1/').split('?')[0]
  const key = `${frame.functionName || '(anon)'} ${source}:${frame.lineNumber + 1}`
  const micros = profile.timeDeltas[i] ?? 0
  selfTime.set(key, (selfTime.get(key) ?? 0) + micros)
  byFile.set(source, (byFile.get(source) ?? 0) + micros)
}
const total = [...selfTime.values()].reduce((sum, micros) => sum + micros, 0)
const report = (heading, tallies, limit) => {
  console.log(heading)
  for (const [key, micros] of [...tallies].sort((left, right) => right[1] - left[1]).slice(0, limit)) {
    console.log(`${(micros / 1000).toFixed(0).padStart(6)}ms  ${key}`)
  }
}
console.log(`first row at ${firstRow}ms; sampled JS self time ${(total / 1000).toFixed(0)}ms`)
report('-- by file', byFile, 18)
report('-- by function', selfTime, 22)
process.exit(0)
