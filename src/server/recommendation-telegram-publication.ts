import { z } from 'zod'

import { type DailyRecommendations } from '../domain/market'
import { type RecommendedOrder } from '../domain/recommended-order'
import { type AppEnv } from './env'
import {
  TELEGRAM_RICH_MESSAGE_MAX_CHARACTERS,
  TelegramSendError,
  type TelegramRichMessage,
  sendTelegramMessage,
  telegramDeliveryConfiguration,
} from './telegram'

const TelegramPublicationRowSchema = z.object({
  status: z.enum(['reserved', 'delivered', 'ambiguous', 'failed']),
  telegram_message_id: z.number().int().nonnegative().nullable(),
})

type PublicationRow = z.infer<typeof TelegramPublicationRowSchema>
interface PublicationFailure {
  errorCode: string
  status: 'ambiguous' | 'failed'
}

type PublicationResolution = PublicationFailure | {
  status: 'delivered'
  telegramMessageId: number
}

export interface PublishDailyRecommendationsToTelegramOptions {
  fetcher?: typeof fetch
  now?: () => Date
}

const expirationDateFormatter = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
  year: 'numeric',
})

function richHtmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function richHtmlAttribute(value: string): string {
  return richHtmlText(value).replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

function optionPositionLine(
  leg: Extract<RecommendedOrder, { kind: 'equity-option' | 'equity-option-vertical' }>['legs'][number],
): string {
  const side = leg.action === 'Buy to Open' ? 'Buy' : 'Sell'
  const contract = leg.contract
  const optionType = contract.optionType === 'C' ? 'Call' : 'Put'
  const expiration = expirationDateFormatter.format(new Date(`${contract.expiry}T00:00:00.000Z`))
  return `${side} $${contract.underlying} $${contract.strike} ${optionType} ${expiration}`
}

function positionLines(order: RecommendedOrder): string[] {
  if (order.kind === 'legacy-unstructured') {
    throw new Error('TelegramPublicationLegacyPositionUnsupported')
  }
  if (order.kind === 'equity') {
    const leg = order.legs[0]
    const side = leg.action === 'Buy to Open' ? 'Buy' : 'Sell'
    return [`${side} $${leg.symbol} Stock`]
  }
  return order.legs.map(optionPositionLine)
}

/** Render only ranked recommendations; empty output should not create channel filler. */
export function dailyRecommendationsTelegramMessages(
  dailyRecommendations: DailyRecommendations,
): TelegramRichMessage[] {
  if (dailyRecommendations.links.length !== dailyRecommendations.recommendations.length) {
    throw new Error(
      `TelegramPublicationLinkCountMismatch:${dailyRecommendations.recommendations.length}:${dailyRecommendations.links.length}`,
    )
  }
  return dailyRecommendations.recommendations.map((recommendation, index) => {
    if (!recommendation.sources.length) throw new Error(`TelegramPublicationSourcesMissing:${index}`)
    const link = dailyRecommendations.links[index]
    if (!link) throw new Error(`TelegramPublicationLinkMissing:${index}`)
    const positions = positionLines(recommendation.recommendedOrder)
      .map((position) => richHtmlText(position))
      .join('<br>')
    const html = [
      ...(link.previewImageUrl
        ? [`<img src="${richHtmlAttribute(link.previewImageUrl)}"/>`]
        : []),
      `<p>${richHtmlText(recommendation.headline)} — ${richHtmlText(recommendation.description)}</p>`,
      `<p><b>${positions}</b></p>`,
      `<p>Risk: ${richHtmlText(recommendation.risk)}</p>`,
      `<p><a href="${richHtmlAttribute(link.url)}">${richHtmlText(link.title)}</a> — ${richHtmlText(link.description)}</p>`,
    ].join('\n\n')
    if (html.length > TELEGRAM_RICH_MESSAGE_MAX_CHARACTERS) {
      throw new Error(`TelegramPublicationMessageTooLong:${index}`)
    }
    return { html }
  })
}

async function reservePublication(
  db: D1Database,
  dailyRecommendationsId: string,
  messageIndex: number,
  reservedAt: string,
): Promise<'delivered' | 'send'> {
  const inserted = await db.prepare(
    `INSERT INTO daily_recommendation_telegram_publications
      (daily_recommendations_id, message_index, status, reserved_at)
     VALUES (?, ?, 'reserved', ?)
     ON CONFLICT (daily_recommendations_id, message_index) DO NOTHING`,
  ).bind(dailyRecommendationsId, messageIndex, reservedAt).run()
  if (inserted.meta.changes === 1) return 'send'

  const candidate = await db.prepare(
    `SELECT status, telegram_message_id
     FROM daily_recommendation_telegram_publications
     WHERE daily_recommendations_id = ? AND message_index = ?`,
  ).bind(dailyRecommendationsId, messageIndex).first<PublicationRow>()
  if (!candidate) throw new Error(`TelegramPublicationReservationConflict:${messageIndex}`)
  const publication = TelegramPublicationRowSchema.parse(candidate)
  if (publication.status === 'delivered' && publication.telegram_message_id !== null) {
    return 'delivered'
  }
  if (publication.status === 'failed') {
    throw new Error(`TelegramPublicationFailed:${messageIndex}`)
  }
  // A prior process crossed, or may be crossing, the external boundary. Never
  // infer non-delivery from the absence of a Telegram confirmation in D1.
  throw new Error(`TelegramPublicationAmbiguous:${messageIndex}`)
}

async function resolvePublication(
  db: D1Database,
  dailyRecommendationsId: string,
  messageIndex: number,
  resolvedAt: string,
  resolution: PublicationResolution,
): Promise<void> {
  const telegramMessageId = 'telegramMessageId' in resolution ? resolution.telegramMessageId : null
  const errorCode = 'errorCode' in resolution ? resolution.errorCode : null
  let result: D1Result
  try {
    result = await db.prepare(
      `UPDATE daily_recommendation_telegram_publications
       SET status = ?, telegram_message_id = ?, error_code = ?, resolved_at = ?
       WHERE daily_recommendations_id = ? AND message_index = ? AND status = 'reserved'`,
    ).bind(
      resolution.status,
      telegramMessageId,
      errorCode,
      resolvedAt,
      dailyRecommendationsId,
      messageIndex,
    ).run()
  } catch {
    throw new Error(`TelegramPublicationResolutionFailed:${messageIndex}`)
  }
  if (result.meta.changes !== 1) {
    throw new Error(`TelegramPublicationResolutionConflict:${messageIndex}`)
  }
}

function sendFailure(cause: unknown): PublicationFailure {
  if (cause instanceof TelegramSendError) {
    return {
      errorCode: cause.message,
      status: cause.certainty === 'definite' ? 'failed' : 'ambiguous',
    }
  }
  return { errorCode: 'TelegramRequestAmbiguous', status: 'ambiguous' }
}

/**
 * Publish the already-persisted public recommendations to the configured channel.
 * D1 is the replay fence; an unresolved reservation is deliberately not retryable.
 */
export async function publishDailyRecommendationsToTelegram(
  env: AppEnv,
  dailyRecommendations: DailyRecommendations,
  options: PublishDailyRecommendationsToTelegramOptions = {},
): Promise<number> {
  const messages = dailyRecommendationsTelegramMessages(dailyRecommendations)
  if (!messages.length) return 0
  if (!env.DB) throw new Error('TelegramPublicationPersistenceUnavailable')
  const configuration = telegramDeliveryConfiguration(env)
  const now = options.now ?? (() => new Date())

  for (const [messageIndex, message] of messages.entries()) {
    const reservation = await reservePublication(
      env.DB,
      dailyRecommendations.id,
      messageIndex,
      now().toISOString(),
    )
    if (reservation === 'delivered') continue

    let telegramMessageId: number
    try {
      telegramMessageId = await sendTelegramMessage(configuration, message, options.fetcher)
    } catch (cause) {
      const failure = sendFailure(cause)
      await resolvePublication(
        env.DB,
        dailyRecommendations.id,
        messageIndex,
        now().toISOString(),
        failure,
      )
      throw new Error(failure.errorCode)
    }
    await resolvePublication(
      env.DB,
      dailyRecommendations.id,
      messageIndex,
      now().toISOString(),
      { status: 'delivered', telegramMessageId },
    )
  }

  console.info(JSON.stringify({
    dailyRecommendationsId: dailyRecommendations.id,
    event: 'DailyRecommendationsTelegramPublished',
    messageCount: messages.length,
  }))
  return messages.length
}
