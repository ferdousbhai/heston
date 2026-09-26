import { SITE_NAME } from '../domain/site'

/**
 * The name as the brand draws it: the part before the first dot, then the rest in the accent
 * colour (`.brand em, .site-brand em`). Derived from the site name, so the two cannot disagree.
 */
export function Wordmark() {
  const split = SITE_NAME.indexOf('.')
  return <span>{SITE_NAME.slice(0, split)}<em>{SITE_NAME.slice(split)}</em></span>
}

export const HOME_LINK_LABEL = `${SITE_NAME} home`
