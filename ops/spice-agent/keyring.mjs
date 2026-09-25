import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

/**
 * Keyring access for the local tools, shared so the proxy and `connect-tastytrade.mjs` read the
 * same entries the same way. It is its own module because importing `proxy.mjs` starts the proxy.
 *
 * Everything goes through the secret-tool binary, and no secret is ever an argv value: a lookup
 * prints the value to our stdout, a store reads it from our stdin.
 *
 * Credentials are filed under the service that issued them, not the app that spends them: the
 * agent token is Spice's, while a client secret and refresh token are tastytrade's and would be
 * Schwab's for a Schwab adapter. That keeps the keyring laid out the way the Worker's adapter
 * registry (`brokerAdaptersSeam` in `src/server/brokers/index.ts`) is, so adding a broker adds a
 * service rather than more keys under this one.
 */

const execFileAsync = promisify(execFile)

/**
 * The stored value, or undefined when there is none.
 *
 * "Not stored" and "could not read the keyring" are different facts. `secret-tool lookup` exits 1
 * and prints nothing when the entry is absent; anything else -- a missing binary, a locked or
 * unreachable keyring, which it reports on stderr -- is a failure, and the calling tool exits
 * rather than carry on as though a credential that is in fact stored were absent. `program` is
 * the caller's log prefix.
 */
export async function keyringSecret(program, service, key) {
  try {
    const { stdout } = await execFileAsync('secret-tool', ['lookup', 'service', service, 'key', key])
    const value = stdout.trim()
    return value || undefined
  } catch (error) {
    if (error?.code === 1 && !String(error.stderr ?? '').trim()) return undefined
    // Fixed vocabulary only: secret-tool's stderr is not echoed.
    process.stderr.write(`${program}: the keyring could not be read (${service}/${key})\n`)
    process.exit(1)
  }
}

/**
 * Store a value, passing it on secret-tool's stdin. Resolves true when secret-tool exits 0; the
 * caller reads the entry back rather than trusting that alone. `label` is only what a keyring UI
 * displays; the service and key attributes are what a lookup finds.
 */
export function keyringStore(service, key, label, value) {
  return new Promise((resolve) => {
    const child = spawn('secret-tool', ['store', `--label=${label}`, 'service', service, 'key', key], {
      stdio: ['pipe', 'ignore', 'ignore'],
    })
    child.on('error', () => resolve(false))
    child.on('close', (status) => resolve(status === 0))
    // A secret-tool that dies before reading surfaces as its exit status, not as an EPIPE here.
    child.stdin.on('error', () => {})
    child.stdin.end(value)
  })
}
