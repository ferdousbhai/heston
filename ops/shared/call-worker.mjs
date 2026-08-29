import { readFile } from 'node:fs/promises'

const [tokenPath, baseUrl, endpoint, bodyPath] = process.argv.slice(2)
if (!tokenPath || !baseUrl || !endpoint) throw new Error('Usage: call-worker.mjs TOKEN URL ENDPOINT [BODY]')
const token = (await readFile(tokenPath, 'utf8')).trim()
const body = bodyPath ? await readFile(bodyPath) : undefined
// Give a newly deployed temporary workers.dev route 30 seconds to propagate.
const DEPLOYMENT_READY_ATTEMPTS = 30
const DEPLOYMENT_RETRY_DELAY_MS = 1_000

for (let attempt = 0; attempt < DEPLOYMENT_READY_ATTEMPTS; attempt += 1) {
  const headers = new Headers({ Authorization: `Bearer ${token}` })
  if (body) headers.set('Content-Type', 'application/json')
  const response = await fetch(`${baseUrl}/${endpoint}`, {
    body,
    headers,
    method: 'POST',
  })
  const text = await response.text()
  // The shared ops gate answers an unauthorized or unknown request with the same
  // 404 a freshly deployed Worker returns before its route propagates, so the
  // only safe reading here is "not ready yet": retry, then fail on the timeout.
  if (response.status === 404 && attempt + 1 < DEPLOYMENT_READY_ATTEMPTS) {
    await new Promise((resolve) => setTimeout(resolve, DEPLOYMENT_RETRY_DELAY_MS))
    continue
  }
  if (!response.ok) throw new Error(text)
  process.stdout.write(`${JSON.stringify(JSON.parse(text), null, 2)}\n`)
  process.exit(0)
}

throw new Error('Temporary Worker did not become ready')
