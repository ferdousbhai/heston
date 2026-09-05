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

const MCP_URL = 'https://tryspice.xyz/mcp'
const PROXY_URL = 'http://127.0.0.1:8787/mcp'

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

  const issue = useCallback(async (label: string) => {
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
    } catch (cause) {
      setError(toError(cause)?.message ?? 'The token could not be created')
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

function CopyBlock({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="connect-code">
      <div className="connect-code-head">
        <span>{label}</span>
        <Button
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 2_000)
            })
          }}
          size="sm"
          variant="ghost"
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre><code>{value}</code></pre>
    </div>
  )
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
    mcpServers: { spice: { headers: { Authorization: `Bearer ${bearer}` }, type: 'http', url: MCP_URL } },
  }, null, 2)
  // No header. Claude Code skips the OAuth flow entirely when a static `Authorization` is
  // configured, so handing one out as the default would ship the browser sign-in and guarantee
  // nobody ever reaches it.
  const claudeCommand = `claude mcp add --transport http spice ${MCP_URL}`
  const headlessCommand = `${claudeCommand} --header "Authorization: Bearer ${bearer}"`

  return (
    <section className="connect-screen">
      <header>
        <h1>Connect your agent</h1>
        <p>
          Spice is a tool surface for an agent running on your own machine — Claude Code, Codex, or
          anything that speaks MCP. Point it here and it can read live quotes, option chains and
          Greeks, the catalyst calendar, the daily brief, and your watchlist and favorites.
        </p>
      </header>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Agent tokens</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <section className="connect-step">
        <h2>1 · Point your agent at Spice</h2>
        <p>
          Run this and your agent opens a browser to sign you in with Google. Nothing to copy, and
          it renews its own access — you should not need to come back here.
        </p>
        <CopyBlock label="Claude Code" value={claudeCommand} />
        <p className="connect-note">
          Any MCP client that speaks OAuth works the same way: point it at <code>{MCP_URL}</code>{' '}
          and it will discover the rest.
        </p>
      </section>

      <section className="connect-step">
        <h2>2 · Connect a brokerage <span className="connect-optional">optional</span></h2>
        <p>
          Everything above works without one. Connecting a brokerage is what adds your balances,
          positions and order history, and lets the agent place orders — against your own account
          only. Spice never receives or stores your brokerage refresh token: it stays in your
          keyring, and a small local proxy exchanges it for a short-lived access token per request.
        </p>
        <p>
          Register a personal OAuth application with tastytrade, store its credentials, and run the
          proxy from <code>ops/spice-agent</code>. Note that tastytrade requires two-factor
          authentication on your account before it will grant the read and trade scopes.
        </p>
        <CopyBlock
          label="Store your credentials"
          value={'./ops/spice-agent/store-credentials.sh tastytrade'}
        />
        <p>
          It prompts for each value and stores it in the keyring, so nothing reaches your shell
          history or any file, then restarts the proxy so it picks them up.
        </p>
        <p>
          With the proxy running, point your agent at <code>{PROXY_URL}</code> instead. It attaches
          both your Spice token and a freshly minted brokerage token to every request.
        </p>
      </section>

      <section className="connect-step">
        <h2>3 · Headless access <span className="connect-optional">optional</span></h2>
        <p>
          A machine that runs unattended cannot complete a browser sign-in, so it uses a token
          instead. This is what the daily research run uses. If you are sitting at a terminal, step
          one is the one you want.
        </p>
        <form
          className="connect-issue"
          onSubmit={(event) => {
            event.preventDefault()
            const trimmed = label.trim()
            if (!trimmed || busy) return
            void issue(trimmed).then(() => setLabel(''))
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
          contract is resolved from the live chain, the portfolio drawdown budget and market checks
          run against fresh broker state, and the broker&apos;s own dry-run must come back clean. A
          refusal is final. Your agent will ask you before placing anything, but that prompt belongs
          to your agent, not to Spice — the guards are what actually bound the risk.
        </p>
        {owner && (
          <p className="connect-owner-note">
            Your account also carries the publishing and research-discovery tools.
          </p>
        )}
      </section>
    </section>
  )
}
