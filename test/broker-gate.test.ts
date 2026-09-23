import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import {
  BrokerGateCore,
  type BrokerGateContext,
  type BrokerGateScheduler,
  type BrokerGateStorage,
  type BrokerGateStoredValue,
} from '../src/server/broker-gate-core'

const TestMutationLeaseSchema = z.object({ expiresAt: z.number(), token: z.string() })

class MemoryStorage implements BrokerGateStorage {
  readonly values = new Map<string, BrokerGateStoredValue>()

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key)
  }

  async get(key: string): Promise<BrokerGateStoredValue | undefined> {
    return this.values.get(key)
  }

  async put(key: string, value: BrokerGateStoredValue): Promise<void> {
    this.values.set(key, value)
  }
}

class ControlledScheduler implements BrokerGateScheduler {
  readonly waits: Array<() => void> = []

  wait(): Promise<void> {
    return new Promise((resolve) => this.waits.push(resolve))
  }

  releaseNext(): void {
    this.waits.shift()?.()
  }
}

function context(storage: BrokerGateStorage): BrokerGateContext {
  return { storage, waitUntil: vi.fn() }
}

describe('BrokerGate durable mutation lease', () => {
  it('preserves serialization when the object is evicted between acquire and release RPCs', async () => {
    const storage = new MemoryStorage()
    const scheduler = new ControlledScheduler()
    const firstInstance = new BrokerGateCore(context(storage), scheduler)
    await firstInstance.initialize()
    const firstToken = await firstInstance.acquireMutation()

    const coldInstance = new BrokerGateCore(context(storage), scheduler)
    await coldInstance.initialize()
    let secondToken: string | undefined
    const secondAcquire = coldInstance.acquireMutation().then((token) => { secondToken = token })
    await vi.waitFor(() => expect(scheduler.waits).toHaveLength(1))
    expect(secondToken).toBeUndefined()

    await firstInstance.releaseMutation(firstToken)
    scheduler.releaseNext()
    await secondAcquire

    expect(secondToken).toBeDefined()
    expect(secondToken).not.toBe(firstToken)
    await coldInstance.releaseMutation(secondToken!)
  })

  it('renews only the exact live token and extends its persisted eviction guard', async () => {
    const storage = new MemoryStorage()
    let now = 1_000
    const core = new BrokerGateCore(context(storage), new ControlledScheduler(), () => now)
    await core.initialize()
    const token = await core.acquireMutation()
    const original = TestMutationLeaseSchema.parse(storage.values.get('active-mutation-lease'))

    now += 60_000
    expect(await core.renewMutation(token)).toBe(true)
    const renewed = TestMutationLeaseSchema.parse(storage.values.get('active-mutation-lease'))

    expect(renewed.expiresAt).toBeGreaterThan(original.expiresAt)
    expect(await core.renewMutation('wrong-token')).toBe(false)
    await core.releaseMutation(token)
  })
})
