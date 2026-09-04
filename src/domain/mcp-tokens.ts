import { z } from 'zod'

/**
 * One token per machine a member connects from. The cap exists so a forgotten laptop cannot
 * accumulate credentials without bound; a member who needs more should revoke a stale one,
 * which is the action the cap is trying to provoke.
 */
export const MAX_MCP_TOKENS_PER_USER = 5

export const McpTokenLabelSchema = z.string().trim().min(1).max(60)

export const McpTokenMetadataSchema = z.strictObject({
  createdAt: z.string(),
  label: McpTokenLabelSchema,
  lastUsedAt: z.string().optional(),
  tokenId: z.string(),
})

export const McpTokenListResponseSchema = z.strictObject({
  tokens: z.array(McpTokenMetadataSchema),
})

/** The plaintext token appears in exactly this one response and is never readable again. */
export const McpTokenIssuedResponseSchema = z.strictObject({
  token: z.string(),
  tokenMetadata: McpTokenMetadataSchema,
})

export const McpTokenIssueRequestSchema = z.strictObject({
  label: McpTokenLabelSchema,
})

export const McpTokenRevokeRequestSchema = z.strictObject({
  tokenId: z.string().min(1).max(64),
})

export type McpTokenMetadata = z.infer<typeof McpTokenMetadataSchema>
