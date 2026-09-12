import { type TSchemaOptions, Type } from 'typebox'

/**
 * A closed set of string values, published the way JSON Schema states one: `enum`.
 *
 * `Type.Union([Type.Literal('a'), Type.Literal('b')])` means the same thing to a validator but
 * emits `{"anyOf":[{"type":"string","const":"a"},...]}` -- about three times the characters of
 * `{"type":"string","enum":["a","b"]}`, and the tool list rides along in every model call, not
 * just the handshake. `Type.Unsafe` keeps the static type exactly as narrow as the union was.
 */
export function StringEnum<const T extends readonly [string, ...string[]]>(
  values: T,
  options: TSchemaOptions = {},
) {
  return Type.Unsafe<T[number]>({ ...options, enum: [...values], type: 'string' })
}
