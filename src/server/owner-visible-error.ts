export type OwnerVisibleErrorKind =
  | 'action-state'
  | 'ambiguous-brokerage'
  | 'broker-credential'
  | 'broker-warning'
  | 'option-contract'
  | 'portfolio-risk'

/** Stable private-domain classification; the HTTP boundary alone chooses a status. */
export class OwnerVisibleError extends Error {
  constructor(readonly kind: OwnerVisibleErrorKind, message: string) {
    super(message)
    this.name = 'OwnerVisibleError'
  }
}
