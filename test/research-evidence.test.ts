import { describe, expect, it } from 'vitest'

import { bindEvidenceSymbols } from '../src/server/research-evidence'

describe('research evidence symbol binding', () => {
  it('uses exact ticker and broker instrument names to associate evidence', () => {
    const evidence = bindEvidenceSymbols([{
      source: 'Reddit · r/wallstreetbets',
      title: 'SpaceX orbital data center launch moved up',
      url: 'https://www.reddit.com/r/wallstreetbets/comments/example',
    }, {
      source: 'Example',
      title: 'NVIDIA announces a new accelerator',
      url: 'https://example.com/nvidia',
    }, {
      source: 'Example',
      title: '$META schedules an event',
      url: 'https://example.com/meta',
    }], [
      { name: 'SpaceX Corporation', symbol: 'SPCX' },
      { name: 'NVIDIA Corporation', symbol: 'NVDA' },
      { name: 'Meta Platforms Inc', symbol: 'META' },
    ])

    expect(evidence[0]?.symbols).toEqual(['SPCX'])
    expect(evidence[1]?.symbols).toEqual(['NVDA'])
    expect(evidence[2]?.symbols).toEqual(['META'])
  })
})
