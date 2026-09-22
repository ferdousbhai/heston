import { Fragment } from 'react'

import { parseThesisMarkdown, type ThesisInline } from '../domain/thesis-markdown'

function Inlines({ inlines }: { inlines: ThesisInline[] }) {
  return (
    <>
      {inlines.map((inline, index) => {
        switch (inline.kind) {
          case 'text': return <Fragment key={index}>{inline.text}</Fragment>
          case 'strong': return <strong key={index}><Inlines inlines={inline.children} /></strong>
          case 'em': return <em key={index}><Inlines inlines={inline.children} /></em>
          case 'link': return <a href={inline.href} key={index} rel="noreferrer" target="_blank"><Inlines inlines={inline.children} /></a>
        }
      })}
    </>
  )
}

/** A thesis, rendered from the Markdown subset the domain parser admits and nothing else. */
export function ThesisMarkdown({ text }: { text: string }) {
  return (
    <div className="thesis">
      {parseThesisMarkdown(text).map((block, index) => {
        if (block.kind === 'heading') return <p className="thesis-heading" key={index}><strong><Inlines inlines={block.inlines} /></strong></p>
        if (block.kind === 'paragraph') return <p key={index}><Inlines inlines={block.inlines} /></p>
        const items = block.items.map((item, itemIndex) => <li key={itemIndex}><Inlines inlines={item} /></li>)
        return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>
      })}
    </div>
  )
}
