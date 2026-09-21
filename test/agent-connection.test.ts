import { describe, expect, it } from 'vitest'

import { readAgentConnection } from '../src/server/agent-connection'
import { authenticateMcpToken, issueMcpToken } from '../src/server/mcp-tokens'
import { migrationStore } from './sqlite-d1'

const NOW = new Date('2026-09-12T14:00:00.000Z')

async function storeWithMembers() {
  const store = await migrationStore()
  for (const [id, email] of [['user-a', 'a@example.com'], ['user-b', 'b@example.com']]) {
    store.sqlite.prepare(
      `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
       VALUES (?, ?, ?, 1, ?, ?)`,
    ).run(id!, 'Member', email!, 'now', 'now')
  }
  return store
}

describe('whether an agent has reached Heston as a member', () => {
  it('is not connected until a token exists or a client is consented to', async () => {
    const store = await storeWithMembers()
    try {
      await expect(readAgentConnection(store.database, 'user-a')).resolves.toEqual({ connected: false })

      const issued = await issueMcpToken(store.database, 'user-a', 'laptop', NOW)
      // Issued is connected: the member has done the setup step the page would send them to.
      // The instant stays absent until the token is actually used, so "never used" is visible.
      await expect(readAgentConnection(store.database, 'user-a')).resolves.toEqual({ connected: true })

      await authenticateMcpToken(store.database, issued.token, NOW)
      await expect(readAgentConnection(store.database, 'user-a'))
        .resolves.toEqual({ connected: true, lastSeenAt: NOW.toISOString() })
      // Another member's agent is not this member's.
      await expect(readAgentConnection(store.database, 'user-b')).resolves.toEqual({ connected: false })
    } finally {
      store.close()
    }
  })

  it('counts an OAuth client the member consented to, without reading the provider\'s dates', async () => {
    const store = await storeWithMembers()
    try {
      store.sqlite.prepare(
        `INSERT INTO "oauthClient" ("id", "clientId", "redirectUris") VALUES ('c1', 'client-1', '[]')`,
      ).run()
      store.sqlite.prepare(
        `INSERT INTO "oauthConsent" ("id", "clientId", "userId", "scopes", "createdAt", "updatedAt")
         VALUES ('consent-1', 'client-1', 'user-b', 'openid', 1757685600000, 1757685600000)`,
      ).run()
      await expect(readAgentConnection(store.database, 'user-b')).resolves.toEqual({ connected: true })
      await expect(readAgentConnection(store.database, 'user-a')).resolves.toEqual({ connected: false })
    } finally {
      store.close()
    }
  })
})
