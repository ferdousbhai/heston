import { z } from 'zod'

/** Exact tastytrade leg actions, as the order placement contract advertises them. */
export const OrderLegActionSchema = z.enum([
  'Buy to Open',
  'Sell to Open',
  'Buy to Close',
  'Sell to Close',
])
