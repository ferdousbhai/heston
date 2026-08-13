export async function readSecret(binding: SecretsStoreSecret | undefined, name: string): Promise<string> {
  if (!binding) throw new Error(`SecretBindingMissing:${name}`)
  const value = (await binding.get()).trim()
  if (!value) throw new Error(`SecretValueMissing:${name}`)
  return value
}

export function hasSecret(binding: SecretsStoreSecret | undefined): binding is SecretsStoreSecret {
  return Boolean(binding && typeof binding.get === 'function')
}
