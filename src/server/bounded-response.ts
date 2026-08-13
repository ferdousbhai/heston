/** Read an upstream response without allocating past the declared boundary. */
export async function readBoundedText(response: Response, maxBytes: number, label: string): Promise<string> {
  const declared = Number(response.headers.get('Content-Length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel()
    throw new Error(`${label}:response-too-large`)
  }
  if (!response.body) return ''

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new Error(`${label}:response-too-large`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

export async function readBoundedJson(response: Response, maxBytes: number, label: string): Promise<unknown> {
  return JSON.parse(await readBoundedText(response, maxBytes, label))
}
