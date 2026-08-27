/**
 * The one mechanism behind every narrow production seam in `src/server/`.
 *
 * Module mocking is banned here (`anti-slop/no-module-mocking`), so a module that owns a
 * side effect other tests do not care about exposes a small typed record of the real
 * implementations instead. Production always reads the record through the seam, so the
 * default is the live code path and a test swaps only the entries it names.
 *
 * `defineSeam` takes the factory that builds the production record rather than the record
 * itself, so `reset` rebuilds from the same source the module started with and cannot drift
 * into restoring a stale stand-in. Derive the exported contract type with `SeamValue` so it
 * keeps tracking the real signatures.
 */
export type Seam<T> = {
  /** The implementations currently in force. */
  current: () => T
  /** Restore the production implementations. */
  reset: () => void
  /** Install stand-ins for a test; pair every call with the seam's `reset`. */
  set: (next: T) => void
}

/** The record type a seam carries, for naming a module's exported seam contract. */
export type SeamValue<S> = S extends Seam<infer T> ? T : never

/** Hold the production implementations `createProduction()` returns, swappable in tests. */
export function defineSeam<T>(createProduction: () => T): Seam<T> {
  let installed: T = createProduction()
  return {
    current: () => installed,
    reset: () => {
      installed = createProduction()
    },
    set: (next: T) => {
      installed = next
    },
  }
}
