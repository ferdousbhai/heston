import { useState } from 'react'

import { Button } from '#/components/ui/button'

export function CopyBlock({ label, value }: { label: string; value: string }) {
  const [copyState, setCopyState] = useState<'copied' | 'failed' | 'idle'>('idle')
  return (
    <div className="connect-code">
      <div className="connect-code-head">
        <span>{label}</span>
        <Button
          onClick={() => {
            // One of these blocks holds a token the server never shows again, so a clipboard
            // that refuses — a denied permission, an unfocused document, a webview, or no
            // clipboard API at all outside a secure context — says so and sends the reader to
            // the block below rather than leaving a button that reads "Copy" and did nothing.
            const clipboard = navigator.clipboard
            if (!clipboard) {
              setCopyState('failed')
              return
            }
            void clipboard.writeText(value).then(
              () => {
                setCopyState('copied')
                setTimeout(() => setCopyState('idle'), 2_000)
              },
              () => setCopyState('failed'),
            )
          }}
          size="sm"
          variant="ghost"
        >
          {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed · select below' : 'Copy'}
        </Button>
      </div>
      <pre><code>{value}</code></pre>
    </div>
  )
}
