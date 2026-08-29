import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export function extractTemporaryWorkerUrl(output, workerName) {
  const workerLabel = workerName.toLowerCase()
  const candidates = output.match(/https:\/\/[^\s]+/g) ?? []
  for (const candidate of candidates.toReversed()) {
    try {
      const url = new URL(candidate)
      if (url.protocol === 'https:'
        && url.hostname.startsWith(`${workerLabel}.`)
        && url.hostname.endsWith('.workers.dev')) {
        return url.origin
      }
    } catch {
      // Wrangler output contains other prose and may contain non-URL punctuation.
    }
  }
  throw new Error(`Wrangler did not report the workers.dev URL for ${workerName}.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [logPath, workerName] = process.argv.slice(2)
  if (!logPath || !workerName) {
    throw new Error('Usage: temporary-worker-url.mjs LOG WORKER_NAME')
  }
  process.stdout.write(`${extractTemporaryWorkerUrl(await readFile(logPath, 'utf8'), workerName)}\n`)
}
