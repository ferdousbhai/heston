import {
  OrderPlacementSchema,
  type FreshOrderPlacement,
  type OrderPlacement,
} from './agent-contracts'
import { BrokerageSubmissionUnknownError, executeOrderPlacement } from './brokerage'
import { quarantineSubmission, recordSubmission, unresolvedSubmission } from './brokerage-reconciliation'
import { type JsonValue } from '../domain/json-payload'
import { type AppEnv } from './env'
import { PortfolioRiskError } from './portfolio-risk'
import { resolveOrderIntent } from './order-intent'
import { brokerAdapterFor } from './brokers'
import { brokerApi } from './tastytrade'
import { internalWatchlistWriter } from './internal-watchlist'
import { BrokerCredentialMissingError, type BrokerCredential } from './broker-credential'

export async function rememberTradeIntentSymbol(env: AppEnv, action: FreshOrderPlacement): Promise<void> {
  const symbol = action.kind === 'place_equity_order' ? action.symbol : action.underlying
  await internalWatchlistWriter().ensureSymbols(env, [symbol], 'trade-intent')
}

/**
 * Place one order, guards first.
 *
 * There is no draft step any more. The agent runs on the member's own machine and its client
 * prompts before the tool executes, so the second channel a server-held confirmation token used
 * to buy no longer exists to be bought. What decides admissibility is unchanged and still runs
 * here: the contract is resolved from the live chain rather than taken from the model, the
 * portfolio and market guards run against fresh broker state, and the broker's own dry-run must
 * come back clean before anything is submitted.
 */
export async function placeBrokerageOrder(
  env: AppEnv,
  untrustedAction: JsonValue,
  credential: BrokerCredential | undefined,
): Promise<{ detail: string; orderId?: string }> {
  if (!credential) throw new BrokerCredentialMissingError()
  if (!env.DB) throw new PortfolioRiskError('The brokerage submission store is unavailable.')
  const action: OrderPlacement = OrderPlacementSchema.parse(untrustedAction)
  const accountNumber = await brokerApi().resolveAccountNumber(env, credential)

  // An ambiguous submission may already be sitting at the broker. Placing another before it is
  // resolved is how one uncertain order becomes two real ones.
  const quarantined = await unresolvedSubmission(env, credential.broker, accountNumber)
  if (quarantined) {
    throw new PortfolioRiskError(
      'A previous submission for this account could not be verified and is still unresolved. '
      + 'Reconcile it against broker order history before placing another order; do not retry the previous one.',
    )
  }

  const intent = await resolveOrderIntent(env, action, accountNumber, credential)
  // Exact contract/order resolution is the deterministic point where a discussed trade becomes
  // a trusted ticker, including price-only replacements.
  await rememberTradeIntentSymbol(env, intent.effectiveAction)

  let receipt: Awaited<ReturnType<typeof executeOrderPlacement>>
  try {
    // `executeOrderPlacement` re-resolves the stored action and re-runs both guards against
    // fresh state before its dry-run, so nothing here is trusted forward from above.
    receipt = await executeOrderPlacement(env, intent.storedAction, credential)
  } catch (error) {
    if (error instanceof BrokerageSubmissionUnknownError) {
      await quarantineSubmission(env, {
        accountNumber,
        broker: credential.broker,
        storedAction: intent.storedAction,
      })
    }
    throw error
  }
  if (receipt.orderId) {
    await recordSubmission(env, {
      accountNumber,
      broker: credential.broker,
      providerOrderId: receipt.orderId,
      storedAction: intent.storedAction,
    })
  }
  return receipt
}

/**
 * Cancel one working order.
 *
 * The placement guard refuses a new order while any live order exists, so without this an
 * order that does not fill blocks the account with no route out but the broker's own app.
 * There is deliberately no guard to run here: cancelling only ever reduces exposure, and the
 * thing that must not happen — an automatic retry after an ambiguous DELETE — is the adapter's
 * responsibility and it raises rather than retries.
 */
export async function cancelBrokerageOrder(
  env: AppEnv,
  orderId: string,
  credential: BrokerCredential | undefined,
): Promise<{ cancelled: string; detail: string }> {
  const adapter = brokerAdapterFor(credential)
  const ref = await adapter.resolveAccountRef(env, credential)
  await adapter.cancelOrder(env, ref, orderId, credential)
  return { cancelled: orderId, detail: `Order #${orderId} cancelled.` }
}
