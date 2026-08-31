import { z } from 'zod'

import { type ResearchBrief } from '../domain/market'
import { type AppEnv } from './env'
import {
  TELEGRAM_MESSAGE_MAX_CHARACTERS,
  TelegramSendError,
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

export interface PublishResearchBriefToTelegramOptions {
  fetcher?: typeof fetch
  now?: () => Date
}

function directionLabel(direction: ResearchBrief['ideas'][number]['direction']): string {
  return direction[0].toUpperCase() + direction.slice(1)
}

/** Render only ranked ideas; empty reports should not create channel filler. */
export function researchBriefTelegramMessages(brief: ResearchBrief): string[] {
  return brief.ideas.map((idea, index) => {
    if (!idea.sources.length) throw new Error(`TelegramPublicationSourcesMissing:${index}`)
    const message = [
      `${idea.symbol} · ${directionLabel(idea.direction)}`,
      idea.headline,
      idea.description,
      ...(idea.play ? [`Potential play: ${idea.play}`] : []),
      `Risk: ${idea.risk}`,
      `Sources:\n${idea.sources.map((source) => source.url).join('\n')}`,
      'Not financial advice.',
    ].join('\n\n')
    if (message.length > TELEGRAM_MESSAGE_MAX_CHARACTERS) {
      throw new Error(`TelegramPublicationMessageTooLong:${index}`)
    }
    return message
  })
}

async function reservePublication(
  db: D1Database,
  briefId: string,
  messageIndex: number,
  reservedAt: string,
): Promise<'delivered' | 'send'> {
  const inserted = await db.prepare(
    `INSERT INTO research_brief_telegram_publications
      (brief_id, message_index, status, reserved_at)
     VALUES (?, ?, 'reserved', ?)
     ON CONFLICT (brief_id, message_index) DO NOTHING`,
  ).bind(briefId, messageIndex, reservedAt).run()
  if (inserted.meta.changes === 1) return 'send'

  const candidate = await db.prepare(
    `SELECT status, telegram_message_id
     FROM research_brief_telegram_publications
     WHERE brief_id = ? AND message_index = ?`,
  ).bind(briefId, messageIndex).first<PublicationRow>()
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
  briefId: string,
  messageIndex: number,
  resolvedAt: string,
  resolution: PublicationResolution,
): Promise<void> {
  const telegramMessageId = 'telegramMessageId' in resolution ? resolution.telegramMessageId : null
  const errorCode = 'errorCode' in resolution ? resolution.errorCode : null
  let result: D1Result
  try {
    result = await db.prepare(
      `UPDATE research_brief_telegram_publications
       SET status = ?, telegram_message_id = ?, error_code = ?, resolved_at = ?
       WHERE brief_id = ? AND message_index = ? AND status = 'reserved'`,
    ).bind(
      resolution.status,
      telegramMessageId,
      errorCode,
      resolvedAt,
      briefId,
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
 * Publish the already-persisted, public brief to the configured channel.
 * D1 is the replay fence; an unresolved reservation is deliberately not retryable.
 */
export async function publishResearchBriefToTelegram(
  env: AppEnv,
  brief: ResearchBrief,
  options: PublishResearchBriefToTelegramOptions = {},
): Promise<number> {
  const messages = researchBriefTelegramMessages(brief)
  if (!messages.length) return 0
  if (!env.DB) throw new Error('TelegramPublicationPersistenceUnavailable')
  const configuration = telegramDeliveryConfiguration(env)
  const now = options.now ?? (() => new Date())

  for (const [messageIndex, message] of messages.entries()) {
    const reservation = await reservePublication(
      env.DB,
      brief.id,
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
        brief.id,
        messageIndex,
        now().toISOString(),
        failure,
      )
      throw new Error(failure.errorCode)
    }
    await resolvePublication(
      env.DB,
      brief.id,
      messageIndex,
      now().toISOString(),
      { status: 'delivered', telegramMessageId },
    )
  }

  console.info(JSON.stringify({
    briefId: brief.id,
    event: 'ResearchBriefTelegramPublished',
    messageCount: messages.length,
  }))
  return messages.length
}
