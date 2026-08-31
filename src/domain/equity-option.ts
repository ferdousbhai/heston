import { type Static, Type } from 'typebox'

import { EquitySymbolType } from './instrument'
import { IsoDateType } from './iso-date'

/** The exact human option tuple accepted by read tools before broker-side resolution. */
export const EquityOptionTupleSchema = Type.Object({
  expiry: IsoDateType,
  optionType: Type.Union([Type.Literal('C'), Type.Literal('P')]),
  strike: Type.Number({ exclusiveMinimum: 0 }),
  underlying: EquitySymbolType,
}, { additionalProperties: false })

export type EquityOptionTuple = Static<typeof EquityOptionTupleSchema>
