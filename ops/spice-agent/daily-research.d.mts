export function alreadyPublishedToday(briefId: string | undefined, today: string): boolean
export function marketDate(now?: Date): string
export function shouldRunForMarket(
  market: { opensAt?: string; state: string },
  now?: Date,
): boolean
export function unattendedPromptSuffix(input: {
  briefId?: string
  market: { opensAt?: string; state: string }
  today: string
}): string
