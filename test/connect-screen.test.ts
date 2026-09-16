import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ConnectScreen } from '../src/components/connect-screen'

describe('Connect screen copy', () => {
  it('gives a proxy add command with no Authorization header, for Claude and Grok', () => {
    const html = renderToStaticMarkup(createElement(ConnectScreen, { owner: false }))
    expect(html).toContain('claude mcp add --transport http spice http://127.0.0.1:8787/mcp')
    expect(html).toContain('grok mcp add --transport http spice http://127.0.0.1:8787/mcp')
    expect(html).toContain('Grok lists tools, not prompts')
    expect(html).toContain('./ops/spice-agent/store-credentials.sh mcp-token')
    expect(html).toContain('./ops/spice-agent/store-credentials.sh tastytrade')
    // OAuth to the public URL remains for clients that can complete a browser sign-in.
    expect(html).toContain('claude mcp add --transport http spice https://tryspice.xyz/mcp')
    // The proxy path must not put a bearer token in the command the agent will store.
    const proxyClaude = html.match(/claude mcp add --transport http spice http:\/\/127\.0\.0\.1:8787\/mcp/)
    expect(proxyClaude).not.toBeNull()
    expect(html).not.toMatch(/http:\/\/127\.0\.0\.1:8787\/mcp[^<]*Authorization/)
  })
})
