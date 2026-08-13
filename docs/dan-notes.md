# Dan Markets-notes audit

This is the one-by-one disposition of the 20 Markdown notes in the Obsidian `Markets` folder, including the embedded 16-page *Synthetic Option* deck and the market-psychology image. The audit was completed on 2026-08-13.

Personal notes are source material, not unquestionable facts. Durable, generalizable rules belong in Dan's system doctrine; current holdings belong in live account context; dated forecasts remain historical scenarios; incomplete or unsafe absolutes are either narrowed into falsifiable rules or excluded.

| Note | Disposition | Doctrine outcome |
| --- | --- | --- |
| Synthetic options | Integrated | Analyze the aggregate payoff and Greeks, not leg labels. Put-call parity is conditional payoff equivalence, not operational identity. Covered calls retain downside and cap upside. The linked speculative GME thesis was not imported. |
| Liquidity cascade | Integrated | Stress funding, leverage, collateral, passive/systematic flows, dealer capacity, and policy assumptions when liquidity reverses. Calm markets are not proof of structural safety; collapse forecasts are scenarios, not certainties. |
| Safe Haven | Integrated / expanded | Survival, multiplicative wealth, cost-effective convex protection, and cash optionality were already central. Added hedge monetization and rebalancing; rejected fixed hedge or cash percentages as universal formulas. |
| Why Long Vol | Already covered | Heavy tails, volatility clustering, path dependence, model limits, ergodicity caveats, and IV's limited meaning were already present. They motivate evaluating convexity, not assuming long volatility is underpriced. |
| IV | Integrated | Event trades forecast both direction and post-event IV. IV crush, theta, and skew can defeat a correct directional call; high IV is not automatically rich and low IV is not automatically cheap. |
| Convexity | Integrated | Prefer properly sized, positive-convexity, bounded-loss exposure when its asymmetry is worth the premium. Options are not automatically convex or safe. |
| Zurich axioms | Integrated selectively | Re-underwrite using the fresh-capital test; do not average down merely because price fell or hold to recover an entry. Anti-diversification, impulsive switching, and other unconditional axioms were not imported. |
| Detecting BS | Integrated | Treat pitches as incentive problems; verify payoff, costs, custody, counterparties, and failure modes. High-return/low-risk claims, opacity, secrecy, and borrowed authority raise the burden of proof. |
| Gamma scalping | Integrated as a guardrail | The note was only a fragment, so it did not become a strategy mandate. Dan requires a realized-versus-implied thesis, hedge rule, liquidity, theta/cost accounting, and adverse-path analysis before claiming an edge. |
| Sentiment | Integrated selectively | Extreme sentiment and fact/discourse gaps are research leads, not automatic fades. Positioning, flows, catalysts, unwind mechanics, and falsification are required. The embedded market-cycle image remains an illustration, not a timing model. |
| Tail hedging | Integrated / corrected | A put protects only matched exposure below its strike through expiry, subject to basis and execution. Out-of-the-money puts do not completely protect a portfolio, and roll and monetization matter. |
| Insights | Integrated / already covered | Existing rules already covered liquidity, psychology, predictability, crowding, narratives, builders, attention, patience, and humility. Added that information matters relative to prior expectations; momentum, volume, and rate of change are context rather than proof. Stale numeric heuristics were excluded. |
| Market Diary | Process only | Dated targets and macro predictions remain historical scenarios. Their durable contribution is a decision record with timestamp, prior, horizon, catalyst, invalidation, and later calibration. |
| Reg NMS | No standalone rule | The note contains only an external link and no self-contained Dan principle. Market-structure claims require direct evidence before entering the doctrine. |
| Thinking in bets | Integrated | Separate decision quality from outcome, update calibrated probabilities with evidence, make the strongest contrary case, and evaluate process across a series rather than one result. |
| Crypto | Dynamic-only | This is a personal holdings inventory, not timeless wisdom. Holdings must come from current, timestamped account context and are never hardcoded into Dan's identity. |
| Delta hedging | Integrated selectively | Dealer hedging is conditional flow: positive aggregate gamma can damp moves and negative gamma can amplify them when rebalancing is material relative to liquidity. Position sign, charm, and vanna estimates are uncertain context, not automatic edge. |
| What changed | Integrated | Before trusting an analogy or backtest, ask what changed in policy, leverage, market structure, participant mix, passive ownership, and financing. Mechanisms must be falsifiable rather than narrative decoration. |
| The Hawk & The Serpent | Integrated selectively | Separate skill from regime tailwinds; treat debt service, maturities, refinancing, currency, collateral, and policy as scenario inputs. Fixed allocations, asset-label safety, and deterministic political or debasement forecasts were excluded. |
| Portfolio construction | Integrated | Classify exposures by the payoff job they actually perform—liquidity, carry, direction, or mechanical hedge—and evaluate the combined portfolio under stress. Labels do not make a holding defensive. |

## Integration boundary

The stable rules live in [`src/server/dan-doctrine.ts`](../src/server/dan-doctrine.ts). Runtime account, market, catalyst, and quote facts remain separate untrusted data. The execution-time portfolio guard remains authoritative; no note or model instruction can bypass it.
