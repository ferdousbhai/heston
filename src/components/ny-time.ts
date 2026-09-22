/** Every dated line on the site: New York time, since that is where the market day is. */
export const nyDateTime = new Intl.DateTimeFormat('en-US', {
  day: 'numeric', hour: 'numeric', minute: '2-digit', month: 'short', timeZone: 'America/New_York', timeZoneName: 'short', year: 'numeric',
})
