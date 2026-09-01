/**
 * Refusing one item without condemning its siblings, and keeping the reasons why.
 *
 * The product does this in several places — a catalyst whose citation does not hold, a recommendation
 * whose quote is absent from its source, a finding no client could read — and each one has to
 * report what it dropped, because a run that verifies little must look different from a run
 * with little to verify. Naming the shape once keeps those from drifting into different conventions
 * of what "rejected" means, and keeps every reason readable as `subject: why`.
 */
export type Verdict<T> = { kept: T } | { rejected: string }
export type Sifted<T> = { kept: T[]; rejected: string[] }

export function sift<In, Out>(
  items: readonly In[],
  judge: (item: In, index: number) => Verdict<Out>,
): Sifted<Out> {
  const kept: Out[] = []
  const rejected: string[] = []
  let index = 0
  for (const item of items) {
    const verdict = judge(item, index)
    index += 1
    if ('kept' in verdict) kept.push(verdict.kept)
    else rejected.push(verdict.rejected)
  }
  return { kept, rejected }
}
