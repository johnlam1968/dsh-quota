import type { PlanStatus, QuotaWindow, WindowRow } from './types.js'

/** The plan facts that decide what "usable" means for one routed model. */
export interface DeriveSpec {
  /** `model_name` carrying the account-wide rolling interval. */
  readonly entry: string
  /**
   * Models subject to the weekly window only. Video models are exempt from
   * the 5-hour window, so a blocked 5-hour interval does not stop them.
   */
  readonly videoModelPatterns: readonly RegExp[]
  /**
   * The `model_remains[]` entry carrying video budgets, or null when the
   * provider reports none. Observed live: a `video` entry sits alongside
   * `general` with its own interval and weekly counters.
   */
  readonly videoEntry: string | null
}

/** Whether this model is governed by the weekly window alone. */
export function isVideoModel(model: string, spec: DeriveSpec): boolean {
  return spec.videoModelPatterns.some(pattern => pattern.test(model))
}

/** The windows that actually gate this model. */
function windowsFor(model: string, spec: DeriveSpec): readonly QuotaWindow[] {
  return isVideoModel(model, spec) ? ['weekly'] : ['5h', 'weekly']
}

/**
 * The row that governs `model` in `window`: the model's own row when the
 * provider reports one, otherwise the account-wide row.
 *
 * An absent row is meaningful, not an error: the provider reports weekly
 * headroom separately and it can read 100% while the 5-hour interval is
 * blocked. Callers therefore treat "no row" as "not blocked", which is the
 * only safe direction — a row we did not read can never wrongly deny a model.
 */
export function rowFor(
  rows: readonly WindowRow[],
  model: string,
  spec: DeriveSpec,
  window: QuotaWindow,
): WindowRow | undefined {
  const video = isVideoModel(model, spec) ? spec.videoEntry : null
  return (
    rows.find(row => row.entry === model && row.window === window) ??
    // A video model's budget lives in its own entry, so it outranks the
    // account-wide row; otherwise a video model would be judged by the text
    // model's 5-hour interval, which does not gate it at all.
    (video === null
      ? undefined
      : rows.find(row => row.entry === video && row.window === window)) ??
    rows.find(row => row.entry === spec.entry && row.window === window)
  )
}

/**
 * Whether a request on `model` would be accepted right now.
 *
 * Non-video models need remaining usage in every window; video models are
 * subject to the weekly window only. The two windows reset independently, so
 * neither is allowed to speak for the other.
 */
function deriveUsable(rows: readonly WindowRow[], model: string, spec: DeriveSpec): boolean {
  return windowsFor(model, spec).every(
    window => rowFor(rows, model, spec, window)?.blocked !== true,
  )
}

/**
 * The rows worth showing a caller, in display order.
 *
 * One entry per gating window, resolved to whichever row actually governs
 * this model, so the prompt line and the tool never disagree with `usable`.
 */
export function effectiveRows(
  rows: readonly WindowRow[],
  model: string,
  spec: DeriveSpec,
): readonly WindowRow[] {
  const resolved: WindowRow[] = []
  for (const window of windowsFor(model, spec)) {
    const row = rowFor(rows, model, spec, window)
    if (row !== undefined) resolved.push(row)
  }
  return resolved
}

/** The next instant at which any blocking row ends, or null when none will. */
export function nextResetAt(rows: readonly WindowRow[]): number | null {
  const pending = rows
    .filter(row => row.blocked && row.resetAt !== null)
    .map(row => row.resetAt as number)
  return pending.length === 0 ? null : Math.min(...pending)
}

/** Convenience wrapper for the common single-plan read. */
export function isUsable(status: PlanStatus | null, model: string, spec: DeriveSpec): boolean {
  // A plan that has never been read successfully does not claim to be
  // blocked; it simply has nothing to say yet.
  if (status === null || status.error !== null) return true
  return deriveUsable(status.rows, model, spec)
}
