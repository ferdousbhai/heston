// Worker-bound secrets (`wrangler secret put`) arrive as plain strings; Secrets Store
// bindings (`secrets_store_secrets` in wrangler.jsonc) arrive as objects exposing
// `.get()`. Which binding is which is fixed by configuration and recorded in `AppEnv`,
// so each kind gets its own reader rather than a runtime shape probe.

function requireValue(value: string, name: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`SecretValueMissing:${name}`)
  return trimmed
}

/** Read a secret bound directly to the Worker as a plain string. */
export function readBoundSecret(binding: string | undefined, name: string): string {
  if (!binding) throw new Error(`SecretBindingMissing:${name}`)
  return requireValue(binding, name)
}

/** Read a secret held in a Secrets Store binding. */
export async function readStoredSecret(binding: SecretsStoreSecret | undefined, name: string): Promise<string> {
  if (!binding) throw new Error(`SecretBindingMissing:${name}`)
  let value: string
  try {
    value = await binding.get()
  } catch {
    throw new Error(`SecretReadFailed:${name}`)
  }
  return requireValue(value, name)
}
