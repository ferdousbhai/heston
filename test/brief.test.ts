import { describe, expect, it } from 'vitest'

import {
  BriefRecommendationSchema,
  DailyBriefSchema,
  DailyBriefSubmissionSchema,
  MAX_THESIS_LENGTH,
} from '../src/domain/brief'
import { parseThesisMarkdown } from '../src/domain/thesis-markdown'
import { dailyBriefFixture } from './fixtures/market'

describe('brief contract', () => {
  it('accepts the fixture', () => {
    expect(DailyBriefSchema.parse(dailyBriefFixture)).toEqual(dailyBriefFixture)
  })

  it('holds every field to its envelope and refuses unknown ones', () => {
    const recommendation = dailyBriefFixture.recommendations[0]!
    expect(BriefRecommendationSchema.safeParse({ ...recommendation, thesis: 'x'.repeat(MAX_THESIS_LENGTH + 1) }).success).toBe(false)
    expect(BriefRecommendationSchema.safeParse({ ...recommendation, symbol: 'nvda' }).data?.symbol).toBe('NVDA')
    expect(BriefRecommendationSchema.safeParse({ ...recommendation, extra: 1 }).success).toBe(false)
    expect(DailyBriefSubmissionSchema.safeParse({ ...dailyBriefFixture }).success).toBe(false)
    expect(DailyBriefSubmissionSchema.safeParse({
      marketDate: '2026-09-22', model: 'm', links: [{ url: 'http://insecure.example/' }], recommendations: [],
    }).success).toBe(false)
    // A model's link that names one host and reaches another, or a literal address, is no citation.
    for (const url of ['https://reuters.com@evil.example/x', 'https://127.0.0.1:8080/']) {
      expect(DailyBriefSubmissionSchema.safeParse({
        marketDate: '2026-09-22', model: 'm', links: [{ url }], recommendations: [],
      }).success).toBe(false)
    }
  })
})

describe('thesis markdown', () => {
  it('parses paragraphs, bullets, emphasis and https links, and nothing else', () => {
    const blocks = parseThesisMarkdown(
      '**Catalyst:** a dated print.\nSecond line.\n\n- IV rank *22*\n- Risk: [guide-down](https://example.com/x) or [bad](javascript:alert(1))\n\n1. first\n2. second\n\n## Why now\n`code` stays text',
    )
    expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'list', 'list', 'heading', 'paragraph'])
    expect(blocks[0]).toEqual({
      kind: 'paragraph',
      inlines: [{ kind: 'strong', children: [{ kind: 'text', text: 'Catalyst:' }] }, { kind: 'text', text: ' a dated print.\nSecond line.' }],
    })
    expect(blocks[1]).toMatchObject({ ordered: false })
    expect(blocks[2]).toMatchObject({ ordered: true, items: [[{ kind: 'text', text: 'first' }], [{ kind: 'text', text: 'second' }]] })
    const risk = blocks[1]?.kind === 'list' ? blocks[1].items[1]! : []
    expect(risk).toContainEqual({ kind: 'link', href: 'https://example.com/x', children: [{ kind: 'text', text: 'guide-down' }] })
    expect(JSON.stringify(risk)).toContain('[bad](javascript:alert(1))')
    expect(JSON.stringify(risk)).not.toContain('"href":"javascript')
    expect(blocks[4]).toEqual({ kind: 'paragraph', inlines: [{ kind: 'text', text: 'code stays text' }] })
  })

  it('renders a link to an uncitable https address as its text alone', () => {
    for (const href of ['https://reuters.com@evil.example/x', 'https://127.0.0.1:8080/', 'https://[::1]/', 'https://example.com:8443/']) {
      expect(parseThesisMarkdown(`See [the **filing**](${href}) now`)).toEqual([{
        kind: 'paragraph',
        inlines: [
          { kind: 'text', text: 'See the ' },
          { kind: 'strong', children: [{ kind: 'text', text: 'filing' }] },
          { kind: 'text', text: ' now' },
        ],
      }])
    }
  })
})
