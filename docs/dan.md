# Dan's trading doctrine

Dan's durable behavior is split across three boundaries:

- `src/server/dan-doctrine.ts` contains the stable system doctrine. Runtime quotes, account state, and the user's message are supplied separately as untrusted data.
- `src/domain/portfolio-risk.ts` owns the binary-Kelly helper and retained-cash new-risk-budget math.
- `src/server/portfolio-risk.ts` is the executable broker boundary. The model cannot bypass it.

## Approximate survival budget

Dan uses a deliberately conservative operating rule:

> Dan does not draft or submit a risk-increasing order whose approximate, contractually bounded modeled worst-case loss would leave less than 60% of the portfolio's recorded high-water net liquidation value.

The guard uses the lower of cash balance and withdrawable cash as the conservative terminal floor for a verified long-only equity/equity-option portfolio. It rejects missing account data, ordinary or complex live orders, unsupported exposure, naked opening sales, unverified closes, and debits beyond the remaining loss budget. It checks once when drafting and again immediately before brokerage submission. Only one risk-increasing trade can be in flight, while cancellations remain available; a submitted trade has a five-minute settlement/cash-refresh quarantine. Per the product's intended approximation, small brokerage and exchange fees are not included.

The account-scoped high-water mark starts when this policy is first activated, is sampled when Dan evaluates the account, and never decreases. Deposits raise it; withdrawals can intentionally make the guard fail closed until the policy is revisited. This is a fail-closed new-risk budget, not a continuously enforced realized-drawdown cap. Hedges are discussed by Dan but are not credited by the execution guard unless their joint payoff can be modeled mechanically. The current single-leg action contract therefore stays deliberately conservative.

Long-option premium is bounded while the option remains an option, but exercise or settlement can create underlying exposure. The guard does not currently enforce a pre-expiry close or exercise instruction; positions carried near expiry fall outside the supported approximation and must be managed in tastytrade. Broker, counterparty, cash custody, market closure, security compromise, and execution failures remain outside any literal guarantee.

## Kelly interpretation

Full Kelly is `max(0, p - (1-p)/b)` for a bounded binary wager with defensible probability `p` and net payoff ratio `b`. Dan's advisory policy treats it as a ceiling and prefers quarter Kelly under uncertainty, then caps size again by the approximate survival budget, liquidity, concentration, and correlation. It does not force binary Kelly onto continuous or path-dependent option payoffs. Unknown edge means no Dan-recommended risk. An exact user-directed order may pass the server boundary only when labeled as neither endorsed nor Kelly-sized.

The 40%-bet/60%-cash example in *Safe Haven* is a known-odds dice illustration, not a universal portfolio allocation. Full Kelly targets log growth, not a hard maximum drawdown.

## Why long vol

Dan assumes empirical short-horizon returns can have tails heavier than a Gaussian benchmark and volatility clustering, while portfolio wealth is path-dependent. Black-Scholes IV is the price-implied scalar that reconciles that model with an observed option price; IV, realized volatility, IV rank, and VIX do not directly give a calibrated probability or timing for the next destructive event. The tails that matter most are partly unknowable.

That supports cost-effective convexity and survival, not indiscriminate option buying. Premium bleed, skew, term structure, liquidity, roll, and monetization determine whether long volatility helps the whole portfolio compound.

## Research basis

- [Wiley sample chapter](https://catalogimages.wiley.com/images/db/pdf/9781394214853.excerpt.pdf): risk as consequential loss; sequential compounding; cost-effective mitigation; explicit warning that the book is not a retail tail-hedging recipe.
- [Universa: The Volatility Tax](https://www.universa.net/UniversaResearch_SafeHavenPart4_VolatilityTax.pdf): arithmetic versus geometric return and why large losses damage compound wealth.
- [Spitznagel's SALT interview](https://archive2.salt.org/talks/library/saltny-42): protection must deliver high crash payoff per unit of drag; naïve far-OTM put buying can be costly and is not the strategy.
- [Safe Haven, Kelly discussion](https://books.google.com/books?id=FpI2EAAAQBAJ&pg=PA81&dq=kelly): full versus fractional Kelly and tail outcomes.
- [Cont, *Empirical properties of asset returns*](https://doi.org/10.1080/713665670): heavy tails, volatility clustering, and other stylized facts of returns.
- [Black–Scholes](https://doi.org/10.1086/260062): the option-pricing framework whose price can be inverted to quote Black–Scholes implied volatility.
- [Cboe VIX methodology](https://cdn.cboe.com/api/global/us_indices/governance/VIX_Methodology.pdf): VIX is calculated from a strip of S&P 500 option prices as a 30-day expected-volatility measure, not a direct crash probability.
- [tastytrade account and instrument fields](https://developer.tastytrade.com/basic-api-usage/): quantity direction, account balances, option symbols, and shares per contract.
