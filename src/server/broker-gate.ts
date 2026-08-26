import { DurableObject } from 'cloudflare:workers'

import { type AppEnv } from './env'
import { BrokerGateCore, type BrokerGateStoredValue } from './broker-gate-core'

/**
 * A single-account REST permit queue. Persisting the next slot avoids a cold-start burst after the
 * object is evicted; mutations still never retry automatically.
 */
export class BrokerGate extends DurableObject<AppEnv> {
  private readonly core: BrokerGateCore

  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env)
    this.core = new BrokerGateCore({
      storage: {
        delete: (key) => ctx.storage.delete(key),
        get: (key) => ctx.storage.get<BrokerGateStoredValue>(key),
        put: (key, value) => ctx.storage.put(key, value),
      },
      waitUntil: (task) => ctx.waitUntil(task),
    }, scheduler)
    ctx.blockConcurrencyWhile(() => this.core.initialize())
  }

  async acquire(): Promise<void> {
    return this.core.acquire()
  }

  /** Serializes broker read-modify-write sequences that cannot be made atomic by one REST call. */
  async acquireMutation(): Promise<string> {
    return this.core.acquireMutation()
  }

  /** Extends a token-checked lease while a bounded multi-request mutation is still progressing. */
  async renewMutation(token: string): Promise<void> {
    return this.core.renewMutation(token)
  }

  async releaseMutation(token: string): Promise<void> {
    return this.core.releaseMutation(token)
  }
}
