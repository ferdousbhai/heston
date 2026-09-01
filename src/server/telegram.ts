import { z } from 'zod'

import { readBoundedJson } from './bounded-response'
import { type AppEnv } from './env'
import { readBoundSecret } from './secrets'

// Telegram's Rich Message contract accepts at most 32,768 UTF-8 text characters.
export const TELEGRAM_RICH_MESSAGE_MAX_CHARACTERS = 32_768
// A successful response echoes the sent message. This budget covers that envelope
// without allowing an untrusted provider response to grow without bound.
const TELEGRAM_RESPONSE_MAX_BYTES = TELEGRAM_RICH_MESSAGE_MAX_CHARACTERS * 2

const TelegramBotTokenSchema = z.string().regex(/^\d+:[A-Za-z0-9_-]+$/)
// Telegram chat identifiers fit within 52 significant bits; public channel usernames
// are accepted too.
const TelegramChatIdSchema = z.string().regex(/^(?:-?[1-9]\d{0,15}|@[A-Za-z0-9_]{1,32})$/)
const TelegramRichMessageHtmlSchema = z.string().min(1).max(TELEGRAM_RICH_MESSAGE_MAX_CHARACTERS)

const TelegramBotResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    result: z.object({ message_id: z.number().int().nonnegative().safe() }).passthrough(),
  }).passthrough(),
  z.object({
    // Telegram documents this integer as subject to change, so do not treat it
    // as an HTTP status or impose an invented range.
    error_code: z.number().int(),
    ok: z.literal(false),
  }).passthrough(),
])

export type TelegramFailureCertainty = 'ambiguous' | 'definite'

export class TelegramSendError extends Error {
  readonly certainty: TelegramFailureCertainty

  constructor(code: string, certainty: TelegramFailureCertainty) {
    super(code)
    this.name = 'TelegramSendError'
    this.certainty = certainty
  }
}

export interface TelegramDeliveryConfiguration {
  botToken: string
  chatId: string
}

export interface TelegramRichMessage {
  html: string
}

/** Validate the secret credential and public channel destination before reserving a send. */
export function telegramDeliveryConfiguration(
  env: Pick<AppEnv, 'TELEGRAM_BOT_TOKEN' | 'TELEGRAM_LONG_VOL_CHAT_ID'>,
): TelegramDeliveryConfiguration {
  const botToken = readBoundSecret(env.TELEGRAM_BOT_TOKEN, 'TELEGRAM_BOT_TOKEN')
  const chatId = env.TELEGRAM_LONG_VOL_CHAT_ID?.trim()
  if (!chatId) throw new Error('TelegramChatIdMissing')
  if (!TelegramBotTokenSchema.safeParse(botToken).success) {
    throw new Error('TelegramBotTokenInvalid')
  }
  if (!TelegramChatIdSchema.safeParse(chatId).success) {
    throw new Error('TelegramChatIdInvalid')
  }
  return { botToken, chatId }
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // The response is already a definite HTTP rejection; cancellation is cleanup only.
  }
}

/** Send a finalized Rich Message; scheduled channel publication never streams a draft. */
export async function sendTelegramMessage(
  configuration: TelegramDeliveryConfiguration,
  input: TelegramRichMessage,
  fetcher: typeof fetch = fetch,
): Promise<number> {
  const botToken = TelegramBotTokenSchema.parse(configuration.botToken)
  const chatId = TelegramChatIdSchema.parse(configuration.chatId)
  const html = TelegramRichMessageHtmlSchema.parse(input.html)
  let response: Response
  try {
    response = await fetcher(`https://api.telegram.org/bot${botToken}/sendRichMessage`, {
      body: JSON.stringify({
        chat_id: chatId,
        rich_message: { html },
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
  } catch {
    // The request may have reached Telegram even though no response reached the Worker.
    throw new TelegramSendError('TelegramRequestAmbiguous', 'ambiguous')
  }
  if (!response.ok) {
    await cancelResponseBody(response)
    throw new TelegramSendError(`TelegramHttpFailure:${response.status}`, 'definite')
  }

  let parsed: z.infer<typeof TelegramBotResponseSchema>
  try {
    parsed = TelegramBotResponseSchema.parse(
      await readBoundedJson(response, TELEGRAM_RESPONSE_MAX_BYTES, 'TelegramSend'),
    )
  } catch {
    // A 2xx response with an unreadable confirmation cannot prove non-delivery.
    throw new TelegramSendError('TelegramResponseAmbiguous', 'ambiguous')
  }
  if (!parsed.ok) {
    throw new TelegramSendError(`TelegramApiFailure:${parsed.error_code}`, 'definite')
  }
  return parsed.result.message_id
}
