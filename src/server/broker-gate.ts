import { DurableObject } from 'cloudflare:workers'

import { type AppEnv } from './env'

const PERMIT_INTERVAL_MS = 500
const NEXT_PERMIT_KEY = 'next-permit-at'

/**
 * A single-account REST permit queue. Persisting the next slot avoids a cold-start burst after the
 * object is evicted; mutations still never retry automatically.
 */
export class BrokerGate extends DurableObject<AppEnv> {
  private nextPermitAt = 0

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
}
