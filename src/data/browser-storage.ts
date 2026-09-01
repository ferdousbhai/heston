export type EnumerableStorage = Pick<
  Storage,
  'getItem' | 'key' | 'length' | 'removeItem' | 'setItem'
>

type StorageHost = { readonly localStorage: Storage }

function memoryStorage(): EnumerableStorage {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size },
    removeItem: (key) => { values.delete(key) },
    setItem: (key, value) => { values.set(key, value) },
  }
}

export function localStorageOrMemory(host: StorageHost | undefined = globalThis.window): EnumerableStorage {
  try {
    return host?.localStorage ?? memoryStorage()
  } catch {
    // Browsers may expose `window` while denying storage access. Collections remain
    // usable in memory so privacy settings cannot turn persistence into a boot failure.
    return memoryStorage()
  }
}

export const browserStorage = localStorageOrMemory()
