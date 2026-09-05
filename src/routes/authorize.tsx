import { Outlet, createFileRoute } from '@tanstack/react-router'

/**
 * A layout, and nothing else.
 *
 * `/authorize/consent` makes this route its parent, so whatever renders here renders on the
 * consent page too. It first held the login page, whose "already signed in, hand the request
 * back" effect then fired on consent as well and bounced the browser between the two until Chrome
 * gave up. The step pages are siblings under this shell; it must stay inert.
 */
export const Route = createFileRoute('/authorize')({
  component: () => <Outlet />,
})
