import { useMemo, useRef } from 'react'
import { X } from 'lucide-react'
import { z } from 'zod'

import { Button } from '#/components/ui/button'
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxSeparator,
} from '#/components/ui/combobox'
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '#/components/ui/drawer'
import { type Ticker, type Watchlist } from '../domain/market'

const WATCHLIST_GROUPS = ['positions', 'private', 'public'] as const
const ComboboxValueSchema = z.string().min(1)
const WATCHLIST_LABELS = {
  private: 'Private watchlists',
  positions: 'Open positions',
  public: 'Public watchlists',
} as const

function getActiveHtmlElement(): HTMLElement | null {
  if (!globalThis.document || !globalThis.HTMLElement) return null
  const activeElement = globalThis.document.activeElement
  return activeElement instanceof globalThis.HTMLElement ? activeElement : null
}

export function TickerPicker({
  onClose,
  onPick,
  tickers,
  watchlists,
}: {
  onClose: () => void
  onPick: (symbol: string) => void
  tickers: Ticker[]
  watchlists: Watchlist[]
}) {
  const finalFocusRef = useRef<HTMLElement | null>(getActiveHtmlElement())
  const tickerBySymbol = useMemo(() => new Map(tickers.map((ticker) => [ticker.symbol, ticker])), [tickers])
  const groups = useMemo(() => WATCHLIST_GROUPS.flatMap((kind) => {
    const lists = watchlists.filter((watchlist) => watchlist.kind === kind)
    return lists.map((watchlist) => ({
      label: `${WATCHLIST_LABELS[kind]} · ${watchlist.name}`,
      value: watchlist.id,
      items: watchlist.symbols.flatMap((symbol) => {
        const ticker = tickerBySymbol.get(symbol)
        return ticker ? [`${ticker.symbol} ${ticker.name}`] : []
      }),
    }))
  }).filter((group) => group.items.length > 0), [tickerBySymbol, watchlists])

  return (
    <Drawer onOpenChange={(open) => { if (!open) onClose() }} open showSwipeHandle>
      <DrawerContent className="ticker-sheet" finalFocus={finalFocusRef}>
        <DrawerHeader className="sheet-header">
          <DrawerTitle id="picker-title">Choose a ticker</DrawerTitle>
          <DrawerDescription className="sr-only">Search every loaded symbol, grouped by watchlist.</DrawerDescription>
          <DrawerClose render={<Button aria-label="Close ticker picker" className="icon-button" size="icon-lg" type="button" variant="outline" />}>
            <X /><span className="sr-only">Close ticker picker</span>
          </DrawerClose>
        </DrawerHeader>
        <Combobox
          autoHighlight
          items={groups}
          onValueChange={(value) => {
            const parsed = ComboboxValueSchema.safeParse(value)
            if (parsed.success) onPick(parsed.data.split(' ')[0])
          }}
        >
          <ComboboxInput
            aria-label="Search symbol or company"
            autoFocus
            className="search-box"
            placeholder="Search symbol or company"
            showClear
          />
          <ComboboxContent className="picker-combobox-content">
            <ComboboxEmpty>No loaded tickers match.</ComboboxEmpty>
            <ComboboxList>
              {(group, index) => (
                <ComboboxGroup items={group.items} key={group.value}>
                  <ComboboxLabel>{group.label}</ComboboxLabel>
                  <ComboboxCollection>
                    {(item) => (
                      <ComboboxItem key={item} value={item}>
                        <strong>{item.split(' ')[0]}</strong>
                        <span>{item.split(' ').slice(1).join(' ')}</span>
                      </ComboboxItem>
                    )}
                  </ComboboxCollection>
                  {index < groups.length - 1 && <ComboboxSeparator />}
                </ComboboxGroup>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
      </DrawerContent>
    </Drawer>
  )
}
