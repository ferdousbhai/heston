import { useEffect, useRef } from 'react'

/**
 * While `active`, ask again whenever the window regains focus. A read that failed would otherwise
 * keep its failure for as long as the view stays mounted, and a reader returning to the tab is the
 * moment worth trying again. The latest `retry` is used without re-subscribing on every render.
 */
export function useRetryOnFocus(active: boolean, retry: () => void): void {
  const latestRetry = useRef(retry)
  useEffect(() => {
    latestRetry.current = retry
  })
  useEffect(() => {
    if (!active) return
    const onFocus = () => latestRetry.current()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [active])
}
