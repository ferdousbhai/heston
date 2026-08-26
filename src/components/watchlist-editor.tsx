import { useRef, useState, type FormEvent } from 'react'
import { Plus, Trash2, X } from 'lucide-react'
import { z } from 'zod'

import { Alert, AlertDescription, AlertTitle } from '#/components/ui/alert'
import { Button } from '#/components/ui/button'
import { ButtonGroup } from '#/components/ui/button-group'
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '#/components/ui/combobox'
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '#/components/ui/drawer'
import { Empty, EmptyDescription, EmptyHeader } from '#/components/ui/empty'
import { Field, FieldGroup, FieldLabel } from '#/components/ui/field'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '#/components/ui/item'
import { Spinner } from '#/components/ui/spinner'
import { type Ticker, type Watchlist } from '../domain/market'
import { type WatchlistMutation } from '../domain/watchlist'

const ComboboxValueSchema = z.string().min(1)

function getActiveHtmlElement(): HTMLElement | null {
  if (!globalThis.document || !globalThis.HTMLElement) return null
  const activeElement = globalThis.document.activeElement
  return activeElement instanceof globalThis.HTMLElement ? activeElement : null
}

export function WatchlistEditor({
  onClose,
  onMutation,
  tickers,
  watchlist,
}: {
  onClose: () => void
  onMutation: (action: WatchlistMutation) => Promise<void>
  tickers: Ticker[]
  watchlist: Watchlist
}) {
  const finalFocusRef = useRef<HTMLElement | null>(getActiveHtmlElement())
  const [symbol, setSymbol] = useState('')
  const [pending, setPending] = useState<string>()
  const [error, setError] = useState<string>()
  const tickerBySymbol = new Map(tickers.map((ticker) => [ticker.symbol, ticker]))
  const availableSymbols = tickers
    .map((ticker) => ticker.symbol)
    .filter((candidate) => !watchlist.symbols.includes(candidate))

  const mutate = async (key: string, action: WatchlistMutation): Promise<boolean> => {
    setPending(key)
    setError(undefined)
    try {
      await onMutation(action)
      return true
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : 'The watchlist could not be updated')
      return false
    } finally {
      setPending(undefined)
    }
  }

  const add = (event: FormEvent) => {
    event.preventDefault()
    const nextSymbol = symbol.trim().toUpperCase()
    if (!/^[A-Z][A-Z.]{0,7}$/.test(nextSymbol)) {
      setError('Enter a valid equity symbol')
      return
    }
    if (watchlist.symbols.includes(nextSymbol)) {
      setError(`${nextSymbol} is already in this watchlist`)
      return
    }
    void (async () => {
      const succeeded = await mutate('add', {
        kind: 'add_watchlist_symbols',
        symbols: [nextSymbol],
      })
      if (succeeded) setSymbol('')
    })()
  }

  const busy = Boolean(pending)
  return (
    <Drawer onOpenChange={(open) => { if (!open && !busy) onClose() }} open showSwipeHandle>
      <DrawerContent className="ticker-sheet watchlist-sheet" finalFocus={finalFocusRef}>
        <DrawerHeader className="sheet-header">
          <DrawerTitle id="watchlist-editor-title">Manage watchlist</DrawerTitle>
          <DrawerDescription>Add or remove symbols from {watchlist.name}.</DrawerDescription>
          <DrawerClose disabled={busy} render={<Button aria-label="Close watchlist editor" className="icon-button" size="icon-lg" type="button" variant="outline" />}>
            <X /><span className="sr-only">Close watchlist editor</span>
          </DrawerClose>
        </DrawerHeader>

        <form className="watchlist-add-form" onSubmit={add}>
          <FieldGroup>
            <Field data-invalid={Boolean(error)}>
              <FieldLabel htmlFor="watchlist-symbol">Add a symbol</FieldLabel>
              <ButtonGroup className="watchlist-add-row">
                <Combobox
                  inputValue={symbol}
                  items={availableSymbols}
                  onInputValueChange={(value) => setSymbol(value.toUpperCase())}
                  onValueChange={(value) => {
                    const parsed = ComboboxValueSchema.safeParse(value)
                    if (parsed.success) setSymbol(parsed.data)
                  }}
                >
                  <ComboboxInput
                    aria-invalid={Boolean(error)}
                    autoCapitalize="characters"
                    autoFocus
                    id="watchlist-symbol"
                    maxLength={8}
                    placeholder="e.g. META"
                    showClear
                  />
                  <ComboboxContent>
                    <ComboboxEmpty>No loaded symbol matches. You can still add the typed equity symbol.</ComboboxEmpty>
                    <ComboboxList>
                      {(candidate) => <ComboboxItem key={candidate} value={candidate}>{candidate}</ComboboxItem>}
                    </ComboboxList>
                  </ComboboxContent>
                </Combobox>
                <Button aria-label="Add symbol" disabled={busy || !symbol.trim()} size="icon-lg" type="submit" variant="default">
                  {pending === 'add' ? <Spinner /> : <Plus />}<span className="sr-only">Add symbol</span>
                </Button>
              </ButtonGroup>
            </Field>
          </FieldGroup>
        </form>

        {error && (
          <Alert className="watchlist-error" variant="destructive">
            <AlertTitle>Watchlist update failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <section className="watchlist-members" aria-labelledby="watchlist-members-title">
          <div className="watchlist-members-heading">
            <h3 id="watchlist-members-title">Items</h3>
            <span>{watchlist.symbols.length}</span>
          </div>
          <ItemGroup>
            {watchlist.symbols.map((member) => (
              <Item className="watchlist-member" key={member} size="sm">
                <ItemContent>
                  <ItemTitle>{member}</ItemTitle>
                  <ItemDescription>{tickerBySymbol.get(member)?.name ?? 'Equity'}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button
                    aria-label={`Remove ${member} from ${watchlist.name}`}
                    disabled={busy}
                    onClick={() => void mutate(`remove-${member}`, {
                      kind: 'remove_watchlist_symbols',
                      symbols: [member],
                    })}
                    size="icon"
                    type="button"
                    variant="destructive"
                  >
                    {pending === `remove-${member}` ? <Spinner /> : <Trash2 />}<span className="sr-only">Remove {member} from {watchlist.name}</span>
                  </Button>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
          {!watchlist.symbols.length && (
            <Empty className="watchlist-empty">
              <EmptyHeader><EmptyDescription>Add a symbol to start this watchlist.</EmptyDescription></EmptyHeader>
            </Empty>
          )}
        </section>
      </DrawerContent>
    </Drawer>
  )
}
