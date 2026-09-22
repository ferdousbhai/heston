import { type z } from 'zod'

/** One fetch for every public JSON read: same headers, same failure, the caller's own schema. */
export async function loadPublicJson<Schema extends z.ZodType>(path: string, schema: Schema, signal?: AbortSignal): Promise<z.infer<Schema>> {
  const response = await fetch(path, { headers: { Accept: 'application/json' }, signal })
  if (!response.ok) throw new Error(`Request failed (${response.status}): ${path}`)
  return schema.parse(await response.json())
}
