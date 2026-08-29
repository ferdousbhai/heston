import { describe, expect, it } from 'vitest'

import { ActionResponseSchema, actionResponseResult } from '../src/components/agent-screen'

describe('agent action response boundary', () => {
  it('accepts only a non-empty server detail for a successful action', () => {
    expect(actionResponseResult(ActionResponseSchema.safeParse({ detail: 'Order accepted' }).data, true)).toEqual({
      detail: 'Order accepted',
    })
    expect(actionResponseResult(ActionResponseSchema.safeParse({}).data, true)).toEqual({
      error: 'The action service returned an invalid response',
    })
    expect(actionResponseResult(undefined, true)).toEqual({
      error: 'The action service returned an invalid response',
    })
    expect(actionResponseResult(ActionResponseSchema.safeParse({ detail: '   ' }).data, true)).toEqual({
      error: 'The action service returned an invalid response',
    })
  })

  it('uses a bounded server error only for a failed HTTP response', () => {
    expect(actionResponseResult(ActionResponseSchema.safeParse({ error: 'Confirmation expired' }).data, false)).toEqual({
      error: 'Confirmation expired',
    })
    expect(actionResponseResult(ActionResponseSchema.safeParse({ error: 'Action resolved' }).data, true)).toEqual({
      error: 'The action service returned an invalid response',
    })
  })
})
