/**
 * State types shared by the pure quota core.
 *
 * Nothing in this module imports dsh. That is the whole point of the split:
 * every fact below can be produced and asserted without a fiber, a config, a
 * clock, or a network.
 */

/** One of the provider's independent rolling windows. */
export type QuotaWindow = '5h' | 'weekly'

/**
 * One narrowed row of the provider's `model_remains[]` response.
 *
 * `entry` is the `model_name` the row came from. The account-wide entry
 * (`general` by configuration) carries the rolling 5-hour interval; a row
 * named after a model scopes to that model.
 */
export interface WindowRow {
  readonly entry: string
  readonly window: QuotaWindow
  readonly blocked: boolean
  readonly remainingPercent: number | null
  /** Absolute epoch ms this window ends, or null when no countdown was reported. */
  readonly resetAt: number | null
}

/**
 * One detached read of a plan.
 *
 * `error` is non-null when the read failed. A failed read is NEVER a
 * transition: it carries no rows, so nothing downstream can mistake it for a
 * reset or for a block.
 *
 * `usable` is deliberately absent. It depends on which model is routed — a
 * video model is subject only to the weekly window — so it is derived in
 * `derive.ts` and never cached here. Two sources of truth for "can I run?"
 * is exactly the bug this type refuses to permit.
 */
export interface PlanStatus {
  readonly provider: string
  readonly checkedAt: number
  readonly rows: readonly WindowRow[]
  readonly error: string | null
}

/**
 * What one session hit, and when. Scoped to a single live subscription.
 *
 * `window` is captured at failure time and is deliberately NOT re-derived from
 * a later reading. By the time the reset arrives nothing is blocked any more,
 * so a status snapshot at wake time cannot say which window expired — only
 * this record can.
 */
export interface BlockRecord {
  readonly window: QuotaWindow
  readonly model: string
  readonly since: number
  readonly code: string
  readonly message: string
}
