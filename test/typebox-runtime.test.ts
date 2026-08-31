import { afterEach, describe, expect, it } from 'vitest'
import { Compile } from 'typebox/compile'
import { Settings } from 'typebox/system'
import { Type } from 'typebox'

import { configureTypeboxRuntime } from '../src/server/typebox-runtime'

afterEach(() => {
  Settings.Reset()
})

/*
 * Node evaluates generated code happily, so nothing here can reproduce the Worker failure
 * directly. What it pins is the property that avoids it: after the entry configures the
 * runtime, a validator compiled later — as the agent runtime does on a tool's first call —
 * generates no code, and still validates.
 */
describe('TypeBox runtime', () => {
  it('compiles validators without generating code', () => {
    configureTypeboxRuntime()

    expect(Compile(Type.Object({ url: Type.String() })).IsAccelerated()).toBe(false)
  })

  it('keeps the interpreted checker equivalent to the generated one', () => {
    configureTypeboxRuntime()
    const validator = Compile(Type.Object({ url: Type.String() }, { additionalProperties: false }))

    expect(validator.Check({ url: 'https://example.com' })).toBe(true)
    expect(validator.Check({ url: 7 })).toBe(false)
    expect(validator.Check({ unexpected: true, url: 'https://example.com' })).toBe(false)
  })
})
