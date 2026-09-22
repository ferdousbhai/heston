import { useCallback, useEffect, useState } from 'react'
import { z } from 'zod'

import { Alert, AlertDescription, AlertTitle } from '#/components/ui/alert'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Spinner } from '#/components/ui/spinner'
import {
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

async function readJson(response: Response) {
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    // The server's own message is the useful one -- it names the token cap, or says the store
    // is unavailable. Anything that does not parse is reported generically rather than guessed at.
    throw new Error(ErrorResponseSchema.safeParse(body).data?.error ?? 'Request failed')
  }
  return body
}

function useAgentTokens() {
  const [tokens, setTokens] = useState<McpTokenMetadata[]>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  /** Shown once, held only in this component's state, never re-fetchable. */
  const [issued, setIssued] = useState<string>()

  // Mirrors useViewer: the first read is owned by the effect and abandoned on unmount, so a
  // slow response can never write into a component that has gone away. Later reads run from
  // event handlers, where `reload` below is fine.
  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/mcp-tokens', { credentials: 'same-origin', signal: controller.signal })
      .then(readJson)
      .then((body) => {
        setTokens(McpTokenListResponseSchema.parse(body).tokens)
        setError(undefined)
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        setError(toError(cause)?.message ?? 'Agent tokens are unavailable')
      })
    return () => controller.abort()
  }, [])

  const reload = useCallback(async () => {
    const body = await readJson(await fetch('/api/mcp-tokens', { credentials: 'same-origin' }))
    setTokens(McpTokenListResponseSchema.parse(body).tokens)
  }, [])

  // Reports whether the token was created, so the caller can keep what the member typed when
  // it was not — a refusal at the token cap is the case where retyping the name is wasted.
  const issue = useCallback(async (label: string): Promise<boolean> => {
    setBusy(true)
    try {
      const body = await readJson(await fetch('/api/mcp-tokens', {
        body: JSON.stringify({ label }),
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }))
      setIssued(McpTokenIssuedResponseSchema.parse(body).token)
      setError(undefined)
      await reload()
      return true
    } catch (cause) {
      setError(toError(cause)?.message ?? 'The token could not be created')
      return false
    } finally {
      setBusy(false)
    }
  }, [reload])

  const revoke = useCallback(async (tokenId: string) => {
    setBusy(true)
    try {
      await readJson(await fetch('/api/mcp-tokens', {
        body: JSON.stringify({ tokenId }),
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        method: 'DELETE',
      }))
      setError(undefined)
      await reload()
    } catch (cause) {
      setError(toError(cause)?.message ?? 'The token could not be revoked')
    } finally {
      setBusy(false)
    }
  }, [reload])

  return { busy, error, issue, issued, revoke, tokens }
}

export function ConnectScreen({ owner }: { owner: boolean }) {
  const { busy, error, issue, issued, revoke, tokens } = useAgentTokens()
  const [label, setLabel] = useState('')

  // While a freshly issued token is on screen, both blocks carry it. A placeholder here made the
  // shortest path copy the token, copy the config, then splice one into the other by hand -- and
  // the token is shown exactly once, so that splice is the step with the most to lose. After the
  // reveal the placeholder is all that can honestly be shown: the digest is all the server kept.
  const bearer = issued ?? 'YOUR_TOKEN'
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
          at all. Connecting yours adds live quotes, option chains and Greeks, lets it add symbols
          to the watchlist, and lets it generate the daily brief everyone reads.
        </p>
      </header>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Agent tokens</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <section className="connect-step">
        <h2>1 · Point your agent at Heston</h2>
        <p>
          Run this and your agent opens a browser to sign you in with Google. Nothing to copy, and
          it renews its own access — you should not need to come back here.
        </p>
        <CopyBlock label="Claude Code" value={claudeCommand} />
        <p className="connect-note">
          Any MCP client that speaks OAuth works the same way: point it at <code>{MCP_URL}</code>.
          If you already run the local proxy below, skip this and point the agent there instead.
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
          No <code>Authorization</code> header. Pointing at <code>{MCP_URL}</code> instead is the
          public snapshot: cached quotes, no chains, no account. Grok lists tools, not prompts;
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
            maxLength={60}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Laptop"
            value={label}
          />
          <Button disabled={busy || !label.trim()} type="submit">
            {busy ? <Spinner /> : 'Create token'}
          </Button>
        </form>

        {issued && (
          <>
            <Alert>
              <AlertTitle>Copy this now</AlertTitle>
              <AlertDescription>
                This is the only time this token is shown. If you lose it, revoke it and create another.
              </AlertDescription>
            </Alert>
            <CopyBlock label="Your token" value={issued} />
          </>
        )}

        {tokens === undefined && <Spinner />}
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
          refusal is final. Your agent will ask you before placing anything, but that prompt belongs
          to your agent, not to Heston — the guards are what actually bound the risk.
        </p>
        {owner && (
          <p className="connect-owner-note">
            Your account also carries the research-discovery and watchlist-removal tools.
          </p>
        )}
      </section>
    </section>
  )
}
