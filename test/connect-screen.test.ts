import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ConnectScreen } from '../src/components/connect-screen'

describe('Connect screen copy', () => {
  it('gives a proxy add command with no Authorization header, for Claude and Grok', () => {
    const html = renderToStaticMarkup(createElement(ConnectScreen, { owner: false }))
    expect(html).toContain('claude mcp add --transport http heston http://127.0.0.1:8787/mcp')
    expect(html).toContain('grok mcp add --transport http heston http://127.0.0.1:8787/mcp')
    expect(html).toContain('Grok lists tools, not prompts')
    expect(html).toContain('./ops/heston-agent/store-credentials.sh mcp-token')
    expect(html).toContain('./ops/heston-agent/store-credentials.sh tastytrade')
    // OAuth to the public URL remains for clients that can complete a browser sign-in.
    expect(html).toContain('claude mcp add --transport http heston https://heston.io/mcp')
    // A header-less request is served at the public tier, never challenged, so adding the
    // server must not be described as what opens the browser.
    expect(html).toContain('connects straight away at the public tier')
    expect(html).not.toContain('Run this and your agent opens a browser')
    // The proxy path must not put a bearer token in the command the agent will store.
    const proxyClaude = html.match(/claude mcp add --transport http heston http:\/\/127\.0\.0\.1:8787\/mcp/)
    expect(proxyClaude).not.toBeNull()
    expect(html).not.toMatch(/http:\/\/127\.0\.0\.1:8787\/mcp[^<]*Authorization/)
  })
})
