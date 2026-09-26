import { SITE_NAME } from '../domain/site'

/**
 * The name as the brand draws it: the part before the first dot, then the rest in the accent
 * colour (`.brand em, .site-brand em`). Derived from the site name, so the two cannot disagree.
 */
export function Wordmark() {
  const split = SITE_NAME.indexOf('.')
  return <span>{SITE_NAME.slice(0, split)}<em>{SITE_NAME.slice(split)}</em></span>
}

/**
 * The pepper beside the wordmark: the one brand every surface draws, so the app, the legal pages
 * and the authorization pages a member reaches mid-flow from an agent all read as the same site.
 * The image is decorative; the wordmark carries the name.
 */
export function BrandMark() {
  return (
    <>
      <img alt="" className="brand-pepper" src="/spice-mark.svg" />
      <Wordmark />
    </>
  )
}

export const HOME_LINK_LABEL = `${SITE_NAME} home`
