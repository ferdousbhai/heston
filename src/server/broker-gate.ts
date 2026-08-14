import { DurableObject } from 'cloudflare:workers'

import { type AppEnv } from './env'

const PERMIT_INTERVAL_MS = 500
const NEXT_PERMIT_KEY = 'next-permit-at'
const MUTATION_LEASE_MS = 2 * 60_000

/**
 * A single-account REST permit queue. Persisting the next slot avoids a cold-start burst after the
 * object is evicted; mutations still never retry automatically.
 */
export class BrokerGate extends DurableObject<AppEnv> {
  private nextPermitAt = 0
  private mutationTail: Promise<void> = Promise.resolve()
  private activeMutation?: { release: () => void; timeout: ReturnType<typeof setTimeout>; token: string }

  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      this.nextPermitAt = await ctx.storage.get<number>(NEXT_PERMIT_KEY) ?? 0
    })
  }

  async acquire(): Promise<void> {
    const now = Date.now()
    const permitAt = Math.max(now, this.nextPermitAt)
    this.nextPermitAt = permitAt + PERMIT_INTERVAL_MS
    await this.ctx.storage.put(NEXT_PERMIT_KEY, this.nextPermitAt)
    const delay = permitAt - now
    if (delay > 0) await scheduler.wait(delay)
  }

  /** Serializes broker read-modify-write sequences that cannot be made atomic by one REST call. */
  async acquireMutation(): Promise<string> {
    const previous = this.mutationTail
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    this.mutationTail = previous.then(() => current)
    await previous
    const token = crypto.randomUUID()
    const timeout = setTimeout(() => this.releaseMutation(token), MUTATION_LEASE_MS)
    this.activeMutation = { release, timeout, token }
    return token
  }

  async releaseMutation(token: string): Promise<void> {
    if (this.activeMutation?.token !== token) return
    clearTimeout(this.activeMutation.timeout)
    const { release } = this.activeMutation
    this.activeMutation = undefined
    release()
  }
}
