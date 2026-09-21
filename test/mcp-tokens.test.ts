import { describe, expect, it } from 'vitest'

import { MAX_MCP_TOKENS_PER_USER } from '../src/domain/mcp-tokens'
import {
  authenticateMcpToken,
  issueMcpToken,
  listMcpTokens,
  McpTokenLimitError,
  revokeMcpToken,
} from '../src/server/mcp-tokens'
import { migrationStore, type SqliteD1Store } from './sqlite-d1'

async function storeWithMembers(): Promise<SqliteD1Store> {
  const store = await migrationStore()
  for (const [id, email] of [['user-a', 'a@example.com'], ['user-b', 'b@example.com']]) {
    store.sqlite.prepare(
      `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
       VALUES (?, ?, ?, 1, ?, ?)`,
    ).run(id!, 'Member', email!, 'now', 'now')
  }
  return store
}

describe('per-user MCP tokens', () => {
  it('authenticates only the exact issued token and never leaks its digest', async () => {
    const store = await storeWithMembers()
    const issued = await issueMcpToken(store.database, 'user-a', 'laptop')
    expect(issued.token).toMatch(/^heston_[0-9a-f]{16}_[A-Za-z0-9_-]{16,}$/)

    await expect(authenticateMcpToken(store.database, issued.token))
      .resolves.toEqual({ tokenId: issued.tokenMetadata.tokenId, userId: 'user-a' })
    // A tampered secret, an unknown id, and a malformed prefix are all simply not authenticated.
    await expect(authenticateMcpToken(store.database, `${issued.token}x`)).resolves.toBeUndefined()
    await expect(authenticateMcpToken(store.database, `heston_${'0'.repeat(16)}_AAAAAAAAAAAAAAAA`))
      .resolves.toBeUndefined()
    await expect(authenticateMcpToken(store.database, 'not-a-heston-token')).resolves.toBeUndefined()
    await expect(authenticateMcpToken(store.database, '')).resolves.toBeUndefined()

    const listed = await listMcpTokens(store.database, 'user-a')
    expect(listed).toEqual([expect.objectContaining({ label: 'laptop', tokenId: issued.tokenMetadata.tokenId })])
    // Nothing on a read path may carry material a token could be reconstructed from.
    expect(JSON.stringify(listed)).not.toContain(issued.token)
    expect(JSON.stringify(listed)).not.toMatch(/digest/i)
    store.close()
  })

  it('lets a member revoke only their own token', async () => {
    const store = await storeWithMembers()
    const mine = await issueMcpToken(store.database, 'user-a', 'laptop')

    // user-b holds a valid session but not this token; the id alone is not authority.
    await expect(revokeMcpToken(store.database, 'user-b', mine.tokenMetadata.tokenId)).resolves.toBe(false)
    await expect(authenticateMcpToken(store.database, mine.token)).resolves.toMatchObject({ userId: 'user-a' })

    await expect(revokeMcpToken(store.database, 'user-a', mine.tokenMetadata.tokenId)).resolves.toBe(true)
    await expect(authenticateMcpToken(store.database, mine.token)).resolves.toBeUndefined()
    store.close()
  })

  it('caps live tokens per member and releases the cap on revocation', async () => {
    const store = await storeWithMembers()
    const issued = []
    for (let index = 0; index < MAX_MCP_TOKENS_PER_USER; index += 1) {
      issued.push(await issueMcpToken(store.database, 'user-a', `machine-${index}`))
    }
    await expect(issueMcpToken(store.database, 'user-a', 'one-too-many'))
      .rejects.toBeInstanceOf(McpTokenLimitError)
    // The cap is per member, so another member is unaffected.
    await expect(issueMcpToken(store.database, 'user-b', 'laptop')).resolves.toBeDefined()

    await revokeMcpToken(store.database, 'user-a', issued[0]!.tokenMetadata.tokenId)
    await expect(issueMcpToken(store.database, 'user-a', 'replacement')).resolves.toBeDefined()
    store.close()
  })

  it('records last use approximately, without a write on every call', async () => {
    const store = await storeWithMembers()
    const issued = await issueMcpToken(store.database, 'user-a', 'laptop')
    const first = new Date('2026-09-04T12:00:00.000Z')

    await authenticateMcpToken(store.database, issued.token, first)
    expect((await listMcpTokens(store.database, 'user-a'))[0]?.lastUsedAt).toBe(first.toISOString())

    // Within the refresh window the stored value is deliberately left alone.
    await authenticateMcpToken(store.database, issued.token, new Date(first.getTime() + 60_000))
    expect((await listMcpTokens(store.database, 'user-a'))[0]?.lastUsedAt).toBe(first.toISOString())

    const later = new Date(first.getTime() + 2 * 60 * 60_000)
    await authenticateMcpToken(store.database, issued.token, later)
    expect((await listMcpTokens(store.database, 'user-a'))[0]?.lastUsedAt).toBe(later.toISOString())
    store.close()
  })

  it('drops a member\'s tokens with their account', async () => {
    const store = await storeWithMembers()
    const issued = await issueMcpToken(store.database, 'user-a', 'laptop')
    store.sqlite.prepare('DELETE FROM "user" WHERE id = ?').run('user-a')
    await expect(authenticateMcpToken(store.database, issued.token)).resolves.toBeUndefined()
    store.close()
  })
})
