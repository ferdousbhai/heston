import { env } from 'cloudflare:workers'

import { type AppEnv } from './env'

/**
 * The Worker bindings this app codes against. Every binding is optional in `AppEnv`, so a
 * binding wrangler has not provisioned reads back as `undefined` at its use site rather
 * than throwing here. Kept apart from `env.ts` so that module stays type-only.
 */
export const appEnv: AppEnv = env
