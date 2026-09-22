import { z } from 'zod'

/** One rule for every page address model output may cite, stated once. */
export const HttpsSourceUrlSchema = z.string().url()
  .refine((url) => new URL(url).protocol === 'https:', 'Use an HTTPS source URL')
