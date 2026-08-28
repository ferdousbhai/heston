// Usage: node measure.mjs <url> <runs> [throttle] [mock=<snapshot.json>]
// With mock=, /api/viewer and /api/public-snapshot are answered in the browser after a fixed
// 120ms/150ms delay, so the number isolates JS delivery, boot order, and render from API latency.
// One of two serving modes must be selected through the environment, as `bench.sh` does:
//   PERF_COMPRESS_UPSTREAM=<origin>              proxy that origin on <url>'s port, Brotli-compressed
//   PERF_STATIC_ROOT=<dir> PERF_SERVER_ENTRY=<js> serve the built document and assets from Playwright
import { chromium } from '@playwright/test'
import { createServer, request as httpRequest } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { brotliCompressSync, createBrotliCompress, constants as zlibConstants } from 'node:zlib'

const [url, runsArg, throttleArg, mockArg] = process.argv.slice(2)
const throttle = throttleArg === 'throttle'
const runs = Number(runsArg ?? 3)
const mockBody = mockArg?.startsWith('mock=') ? await readFile(mockArg.slice(5), 'utf8') : undefined
const compressUpstream = process.env.PERF_COMPRESS_UPSTREAM
const staticRoot = process.env.PERF_STATIC_ROOT
const serverEntry = process.env.PERF_SERVER_ENTRY
const brotliOptions = { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } }

// `vite preview` serves assets uncompressed, unlike production (brotli). A local
// compressing proxy in front of it keeps transfer sizes representative.
if (compressUpstream) {
  const proxy = createServer((req, res) => {
    const headers = { ...req.headers, host: new URL(compressUpstream).host, 'accept-encoding': 'identity' }
    const upstream = httpRequest(new URL(req.url, compressUpstream), { method: req.method, headers }, (up) => {
      const compressible = /javascript|json|css|html|svg|text/.test(up.headers['content-type'] ?? '')
      const responseHeaders = { ...up.headers }
      delete responseHeaders['content-length']
      if (compressible) responseHeaders['content-encoding'] = 'br'
      res.writeHead(up.statusCode ?? 200, responseHeaders)
      if (compressible) up.pipe(createBrotliCompress(brotliOptions)).pipe(res)
      else up.pipe(res)
    })
    req.pipe(upstream)
  })
  await new Promise((ready) => proxy.listen(new URL(url).port, '127.0.0.1', ready))
}

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.woff2', 'font/woff2'],
])

// Restricted sandboxes may deny every TCP listener. Rendering the built Worker document here
// and serving `dist/client` through request interception keeps the measurement possible.
let staticDocument
if (staticRoot && serverEntry) {
  const { registerHooks } = await import('node:module')
  const stub = `
    export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env } }
    export class RpcTarget {}
    export const env = {}
    export const exports = {}
    export const tracing = undefined
  `
  registerHooks({
    resolve(specifier, context, nextResolve) {
      return specifier === 'cloudflare:workers'
        ? { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(stub)}` }
        : nextResolve(specifier, context)
    },
  })
  const worker = await import(pathToFileURL(resolve(serverEntry)).href)
  const response = await worker.default.fetch(new Request(url), {})
  if (!response.ok) throw new Error(`Built document render failed (${response.status})`)
  staticDocument = Buffer.from(await response.arrayBuffer())
}

const staticFile = async (pathname) => {
  if (pathname === '/') return { body: staticDocument, type: 'text/html; charset=utf-8' }
  const root = resolve(staticRoot)
  const file = resolve(root, `.${decodeURIComponent(pathname)}`)
  if (file !== root && !file.startsWith(`${root}${sep}`)) return undefined
  try {
    return { body: await readFile(file), type: contentTypes.get(extname(file)) ?? 'application/octet-stream' }
  } catch {
    return undefined
  }
}

const mockJson = (page, pattern, delayMs, body) => page.route(pattern, async (route) => {
  await new Promise((done) => setTimeout(done, delayMs))
  await route.fulfill({ contentType: 'application/json', body })
})

const results = []
const browser = await chromium.launch()
for (let i = 0; i < runs; i++) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  if (staticDocument) {
    await page.route('**/*', async (route) => {
      const file = await staticFile(new URL(route.request().url()).pathname)
      if (!file) {
        await route.fulfill({ status: 404, body: 'Not found' })
        return
      }
      const body = brotliCompressSync(file.body, brotliOptions)
      await route.fulfill({
        body,
        headers: {
          'content-encoding': 'br',
          'content-length': String(body.length),
          'content-type': file.type,
        },
      })
    })
  }
  const cdp = await context.newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  if (throttle) {
    // ~4G-ish mobile: 9Mbps down, 1.5Mbps up, 150ms RTT, 4x CPU slowdown
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 9e6 / 8, uploadThroughput: 1.5e6 / 8 })
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  }
  if (mockBody) {
    await mockJson(page, '**/api/viewer', 120, JSON.stringify({ authRequired: true, user: null }))
    await mockJson(page, '**/api/public-snapshot', 150, mockBody)
  }
  const requests = new Map()
  const t0 = Date.now()
  page.on('request', (request) => requests.set(request.url(), { start: Date.now() - t0 }))
  page.on('response', (response) => {
    const timing = requests.get(response.url())
    if (timing) timing.end = Date.now() - t0
  })
  await page.addInitScript(() => {
    window.__lcp = 0; window.__fcp = 0
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lcp = e.startTime }).observe({ type: 'largest-contentful-paint', buffered: true })
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') window.__fcp = e.startTime }).observe({ type: 'paint', buffered: true })
  })
  await page.goto(url, { waitUntil: 'commit' })
  const firstRowMs = await page.locator('.premium-data-table tbody tr').first()
    .waitFor({ state: 'visible', timeout: 60_000 })
    .then(() => Date.now() - t0)
    .catch(() => -1)
  await page.waitForTimeout(1500)
  const nav = await page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0]
    const resources = performance.getEntriesByType('resource')
    const transferred = (extension) => resources
      .filter((resource) => resource.name.endsWith(extension))
      .reduce((total, resource) => total + (resource.transferSize || 0), 0)
    return {
      ttfb: Math.round(navigation.responseStart),
      domContentLoaded: Math.round(navigation.domContentLoadedEventEnd),
      load: Math.round(navigation.loadEventEnd),
      fcp: Math.round(window.__fcp),
      lcp: Math.round(window.__lcp),
      jsBytes: transferred('.js'),
      cssBytes: transferred('.css'),
      fontBytes: transferred('.woff2'),
      requests: resources.length,
    }
  })
  const api = [...requests.entries()]
    .filter(([requestUrl]) => requestUrl.includes('/api/'))
    .map(([requestUrl, timing]) => `${new URL(requestUrl).pathname} ${timing.start}→${timing.end ?? '?'}ms`)
  results.push({ run: i + 1, firstRowMs, ...nav, api })
  await context.close()
}
await browser.close()
const med = (key) => {
  const values = results.map((result) => result[key]).sort((a, b) => a - b)
  return values[Math.floor(values.length / 2)]
}
console.log(JSON.stringify({
  url,
  throttle,
  runs,
  median: {
    ttfb: med('ttfb'),
    fcp: med('fcp'),
    lcp: med('lcp'),
    firstRowMs: med('firstRowMs'),
    domContentLoaded: med('domContentLoaded'),
    load: med('load'),
  },
  bytes: {
    js: results[0].jsBytes,
    css: results[0].cssBytes,
    fonts: results[0].fontBytes,
    requests: results[0].requests,
  },
  api: results[0].api,
}, null, 1))
// The proxy listener and Playwright's transport keep the loop alive; leave once the report flushes.
setTimeout(() => process.exit(0), 50)
