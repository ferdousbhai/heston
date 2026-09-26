/**
 * The product's one public address. The brand is the domain, so the name every surface shows --
 * page titles, the sign-in consent screen, the guide an agent reads -- is derived from it rather
 * than typed again, and a future move changes this line and nothing else. The PWA manifest is
 * static JSON and names it separately.
 */
export const SITE_ORIGIN = 'https://spicy.trade'
export const SITE_NAME = new URL(SITE_ORIGIN).host
/** Where the MCP surface is served, on this origin and no other. */
export const MCP_PATH = '/mcp'
export const MCP_ENDPOINT = `${SITE_ORIGIN}${MCP_PATH}`

/** Where readers write: support, privacy requests, and legal notices, all on the site's own domain. */
export const SUPPORT_EMAIL = `support@${SITE_NAME}`
export const PRIVACY_EMAIL = `privacy@${SITE_NAME}`
export const LEGAL_EMAIL = `legal@${SITE_NAME}`

/** A page's document title: what the page is, then whose it is. */
export function pageTitle(page: string): string {
  return `${page} | ${SITE_NAME}`
}
