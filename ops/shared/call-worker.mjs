import { readFile } from 'node:fs/promises'

const [tokenPath, baseUrl, endpoint, bodyPath] = process.argv.slice(2)
if (!tokenPath || !baseUrl || !endpoint) throw new Error('Usage: call-worker.mjs TOKEN URL ENDPOINT [BODY]')
const token = (await readFile(tokenPath, 'utf8')).trim()
const body = bodyPath ? await readFile(bodyPath) : undefined

for (let attempt = 0; attempt < 30; attempt += 1) {
  const headers = new Headers({ Authorization: `Bearer ${token}` })
  if (body) headers.set('Content-Type', 'application/json')
  const response = await fetch(`${baseUrl}/${endpoint}`, {
    body,
    headers,
    method: 'POST',
  })
  const text = await response.text()
  if (response.status === 404 && attempt < 29) {
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    continue
  }
  if (!response.ok) throw new Error(text)
  process.stdout.write(`${JSON.stringify(JSON.parse(text), null, 2)}\n`)
  process.exit(0)
}

throw new Error('Temporary Worker did not become ready')
