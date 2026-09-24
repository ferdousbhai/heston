import { useCallback, useEffect, useState } from 'react'
import { z } from 'zod'

import { Alert, AlertDescription, AlertTitle } from '#/components/ui/alert'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Spinner } from '#/components/ui/spinner'
import {
  MAX_MCP_TOKEN_LABEL_LENGTH,
  McpTokenIssuedResponseSchema,
  McpTokenListResponseSchema,
  type McpTokenMetadata,
} from '../domain/mcp-tokens'
import { toError } from '../domain/failure'
import { CopyBlock } from './copy-block'

const MCP_URL = 'https://heston.io/mcp'
const PROXY_URL = 'http://127.0.0.1:8787/mcp'
/** No Authorization header: the proxy attaches the keyring token so the agent holds none. */
const PROXY_CLAUDE_COMMAND = `claude mcp add --transport http heston ${PROXY_URL}`
const PROXY_GROK_COMMAND = `grok mcp add --transport http heston ${PROXY_URL}`

/** The shape every failing handler in api.mcp-tokens returns. */
const ErrorResponseSchema = z.object({ error: z.string() })

/**
 * A 2xx body that is not the documented shape is a server or deploy mismatch, not something the
 * member can act on, and a Zod issue list is not something they can read.
 */
const UNEXPECTED_RESPONSE = 'Agent tokens returned an unexpected response.'

async function readJson<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    // The server's own message is the useful one -- it names the token cap, or says the store
    // is unavailable. Anything that does not parse is reported generically rather than guessed at.
    throw new Error(ErrorResponseSchema.safeParse(body).data?.error ?? 'Request failed')
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw new Error(UNEXPECTED_RESPONSE)
  return parsed.data
}

function useAgentTokens() {
  const [tokens, setTokens] = useState<McpTokenMetadata[]>()
  // A failed list read and a failed action are different facts: a create that succeeds says
  // nothing about the list, so it clears its own error but never the read's.
  const [listError, setListError] = useState<string>()
  const [actionError, setActionError] = useState<string>()
  /** Which action is in flight, so only its own button shows it working. */
  const [pending, setPending] = useState<{ kind: 'issue' } | { kind: 'revoke'; tokenId: string }>()
  /** True only while the first read is in flight, so a failed read does not spin forever. */
  const [loading, setLoading] = useState(true)
  /**
   * Shown once, held only in this component's state, never re-fetchable. Its id travels with it
   * so revoking that very token also takes it off the screen.
   */
  const [issued, setIssued] = useState<{ token: string; tokenId: string }>()

  // Mirrors useViewer: the first read is owned by the effect and abandoned on unmount, so a
  // slow response can never write into a component that has gone away. After that the list
  // changes only through create and revoke, whose answers carry what changed.
  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/mcp-tokens', { credentials: 'same-origin', signal: controller.signal })
      .then((response) => readJson(response, McpTokenListResponseSchema))
      .then((body) => {
        setTokens(body.tokens)
        setListError(undefined)
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        setListError(toError(cause)?.message ?? 'Agent tokens are unavailable')
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [])

  // Reports whether the token was created, so the caller can keep what the member typed when
  // it was not — a refusal at the token cap is the case where retyping the name is wasted.
  const issue = useCallback(async (label: string): Promise<boolean> => {
    setPending({ kind: 'issue' })
    try {
      const body = await readJson(await fetch('/api/mcp-tokens', {
        body: JSON.stringify({ label }),
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }), McpTokenIssuedResponseSchema)
      // The create answers with the new token's metadata, so the list grows from that rather than
      // from a second read: a re-read that failed would report a created token as not created.
      setIssued({ token: body.token, tokenId: body.tokenMetadata.tokenId })
      // Only a list that was actually read grows; one that never loaded stays unknown rather
      // than being shown as just the new token.
      setTokens((current) => current && [...current, body.tokenMetadata])
      setActionError(undefined)
      return true
    } catch (cause) {
      setActionError(toError(cause)?.message ?? 'The token could not be created')
      return false
    } finally {
      setPending(undefined)
    }
  }, [])

  const revoke = useCallback(async (tokenId: string) => {
    setPending({ kind: 'revoke', tokenId })
    try {
      // A revoke answers with the remaining list, so it is read here rather than fetched again.
      const body = await readJson(await fetch('/api/mcp-tokens', {
        body: JSON.stringify({ tokenId }),
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        method: 'DELETE',
      }), McpTokenListResponseSchema)
      // The answer is the whole remaining list, so it settles a failed first read too.
      setTokens(body.tokens)
      setListError(undefined)
      setIssued((current) => (current?.tokenId === tokenId ? undefined : current))
      setActionError(undefined)
    } catch (cause) {
      setActionError(toError(cause)?.message ?? 'The token could not be revoked')
    } finally {
      setPending(undefined)
    }
  }, [])

  return { actionError, issue, issued, listError, loading, pending, revoke, tokens }
}

export function ConnectScreen({ owner }: { owner: boolean }) {
  const { actionError, issue, issued, listError, loading, pending, revoke, tokens } = useAgentTokens()
  // Every token control waits for whichever action is in flight.
  const busy = pending !== undefined
  const [label, setLabel] = useState('')

  // While a freshly issued token is on screen, both blocks carry it. A placeholder here made the
  // shortest path copy the token, copy the config, then splice one into the other by hand -- and
  // the token is shown exactly once, so that splice is the step with the most to lose. After the
  // reveal the placeholder is all that can honestly be shown: the digest is all the server kept.
  const bearer = issued?.token ?? 'YOUR_TOKEN'
  const mcpConfig = JSON.stringify({
    mcpServers: { heston: { headers: { Authorization: `Bearer ${bearer}` }, type: 'http', url: MCP_URL } },
  }, null, 2)
  // No header. Claude Code skips the OAuth flow entirely when a static `Authorization` is
  // configured, so handing one out as the default would ship the browser sign-in and guarantee
  // nobody ever reaches it.
  const claudeCommand = `claude mcp add --transport http heston ${MCP_URL}`
  const headlessCommand = `${claudeCommand} --header "Authorization: Bearer ${bearer}"`

  return (
    <section className="connect-screen">
      <header>
        <h1>Connect your agent</h1>
        <p>
          Heston is a tool surface for an agent running on your own machine — Claude Code, Grok, Codex, or
          anything that speaks MCP. Any agent can read the public market surface without signing in
          at all. Signing yours in adds live quotes, option chains and Greeks, lets it add symbols
          to the watchlist, and lets it record catalysts and evidence everyone reads.
        </p>
      </header>

      <section className="connect-step">
        <h2>1 · Point your agent at Heston</h2>
        {/* A request with no credential is served, not challenged (src/server/mcp.ts), so adding
            the server never starts a sign-in by itself. Sign-in is whatever the client does with
            the OAuth discovery documents Heston publishes, which varies by client. */}
        <p>
          Run this and your agent connects straight away at the public tier: the cached market
          snapshot, price history, and the shared research, with nothing to copy and no sign-in.
        </p>
        <CopyBlock label="Claude Code" value={claudeCommand} />
        <p>
          To add live quotes, option chains, and Greeks, sign in from your client&apos;s own
          authenticate action for this server. Heston publishes standard OAuth discovery, so a
          client that supports it opens a browser to sign you in with Google and renews its own
          access — you should not need to come back here.
        </p>
        <p className="connect-note">
          Any MCP client can point at <code>{MCP_URL}</code>; signing in needs one that can start
          OAuth from that discovery. If you already run the local proxy below, skip this and point
          the agent there instead.
        </p>
      </section>

      <section className="connect-step">
        <h2>2 · Local proxy <span className="connect-optional">optional</span></h2>
        <p>
          A process on this machine attaches the Heston token from the keyring so the agent holds
          none. That is how live quotes, chains, and Greeks reach a client that cannot complete a
          browser sign-in.
        </p>
        <CopyBlock
          label="Store your Heston token"
          value={'./ops/heston-agent/store-credentials.sh mcp-token'}
        />
        <p>Issue the token in step 3, paste it at the prompt. The script restarts the proxy.</p>
        <CopyBlock label="Claude Code" value={PROXY_CLAUDE_COMMAND} />
        <CopyBlock label="Grok" value={PROXY_GROK_COMMAND} />
        <p className="connect-note">
          No <code>Authorization</code> header. Pointing at <code>{MCP_URL}</code> without signing
          in is the public snapshot: cached quotes, no chains, no account. Grok lists tools, not prompts;
          every tool&apos;s own description carries its contract.
        </p>
        <p>
          A brokerage is a second store: balances, positions, order history, and orders against
          your account only. tastytrade needs a personal OAuth app and two-factor authentication.
        </p>
        <CopyBlock
          label="Store your brokerage credentials"
          value={'./ops/heston-agent/store-credentials.sh tastytrade'}
        />
      </section>

      <section className="connect-step">
        <h2>3 · Headless access <span className="connect-optional">optional</span></h2>
        <p>
          A machine that runs unattended cannot complete a browser sign-in, so it uses a token
          instead. If you are sitting at a terminal, step one is the one you want.
        </p>
        <form
          className="connect-issue"
          onSubmit={(event) => {
            event.preventDefault()
            const trimmed = label.trim()
            if (!trimmed || busy) return
            void issue(trimmed).then((created) => { if (created) setLabel('') })
          }}
        >
          <Input
            aria-label="Token name"
            maxLength={MAX_MCP_TOKEN_LABEL_LENGTH}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Laptop"
            value={label}
          />
          <Button disabled={busy || !label.trim()} type="submit">
            {pending?.kind === 'issue' ? <Spinner /> : 'Create token'}
          </Button>
        </form>

        {/* Every token failure -- the list read, a create, a revoke -- comes from this step, so it
            is reported here, beside the control that caused it, not at the top of a long page. */}
        {actionError && (
          <Alert variant="destructive">
            <AlertTitle>Agent tokens</AlertTitle>
            <AlertDescription>{actionError}</AlertDescription>
          </Alert>
        )}
        {listError && (
          <Alert variant="destructive">
            <AlertTitle>Agent token list</AlertTitle>
            <AlertDescription>{listError}</AlertDescription>
          </Alert>
        )}

        {issued && (
          <>
            <Alert>
              <AlertTitle>Copy this now</AlertTitle>
              <AlertDescription>
                This is the only time this token is shown. If you lose it, revoke it and create another.
              </AlertDescription>
            </Alert>
            <CopyBlock label="Your token" value={issued.token} />
          </>
        )}

        {/* Only while the first read is in flight: once it has failed, the alert above the list is the
            answer, and a spinner beside it would claim a read that is no longer happening. */}
        {loading && <Spinner />}
        {tokens?.length === 0 && <p className="connect-empty">No tokens yet.</p>}
        {tokens && tokens.length > 0 && (
          <ul className="connect-tokens">
            {tokens.map((token) => (
              <li key={token.tokenId}>
                <div>
                  <strong>{token.label}</strong>
                  <span>
                    {token.lastUsedAt
                      ? `last used ${new Date(token.lastUsedAt).toLocaleDateString()}`
                      : 'never used'}
                  </span>
                </div>
                <Button disabled={busy} onClick={() => void revoke(token.tokenId)} size="sm" variant="ghost">
                  {pending?.kind === 'revoke' && pending.tokenId === token.tokenId
                    ? <Spinner data-icon="inline-start" />
                    : null}
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}

        <p>
          {issued
            ? 'Both blocks below already carry the token you just created — copy either one.'
            : 'Substitute a token above; it is shown only at the moment it is issued.'}
        </p>
        <CopyBlock label="Command" value={headlessCommand} />
        <CopyBlock label=".mcp.json" value={mcpConfig} />
        <p className="connect-note">
          A configured <code>Authorization</code> header takes precedence over the browser flow, so
          use this only where there is no browser.
        </p>
      </section>

      <section className="connect-step">
        <h2>What the agent cannot do</h2>
        <p>
          Orders run the same server-side guards regardless of what any agent recommends: the exact
          contract is resolved from the live chain, the portfolio and market checks
          run against fresh broker state, and the broker&apos;s own dry-run must come back clean. A
          refusal is final. Heston has no confirmation step of its own: any prompt before an order
          comes from your agent, and the server-side guards are what bound the risk.
        </p>
        {owner && (
          <p className="connect-owner-note">
            Your account also carries the owner&apos;s watchlist reach: <code>read_watchlist</code>{' '}
            takes a symbol and names where it came from, and <code>manage_watchlist</code> adds to or
            removes from the shared watchlist.
          </p>
        )}
      </section>
    </section>
  )
}
