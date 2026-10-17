import type { PlanStatus, WindowRow } from './types.js'

/** What the probe needs to know about the plan it is reading. */
export interface ProbeSpec {
  readonly provider: string
  /** The `model_name` carrying the account-wide rolling interval. */
  readonly entry: string
}

/** The provider's "interval exhausted" marker on `current_interval_status`. */
const STATUS_EXHAUSTED = 2

function failed(provider: string, now: number, error: string): PlanStatus {
  // Rows are empty on purpose. A failed read must be indistinguishable from
  // "nothing changed" to every consumer, never from "reset".
  return { provider, checkedAt: now, rows: [], error }
}

/** A checked narrowing, not an assertion: JSON.parse hands back `unknown`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isPositiveCountdown(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0
}

/** A percentage the provider reported, or null when it reported nothing usable. */
function narrowPercent(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null
}

function narrowNumber(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null
}

/** A millisecond countdown turned into an absolute instant, or null. */
function narrowCountdown(value: unknown, now: number): number | null {
  return isPositiveCountdown(value) ? now + value : null
}

/**
 * Narrow one provider response into detached rows.
 *
 * Never throws and never partially succeeds: every failure path returns a
 * status whose only populated field is `error`. The endpoint is untrusted
 * input, so every field is narrowed by an explicit check and nothing is cast.
 *
 * `model_remains` holds one entry per account group — `general` and `video`
 * were both observed — and every entry carries BOTH windows as parallel field
 * families. See `docs/.superpowers/live-response-shape.md` for the measured
 * shape; it replaces an earlier guess that the weekly window lived elsewhere.
 *
 * The two windows block on DIFFERENT evidence, which is not a stylistic choice.
 * Measured: `current_interval_status` reads 1 when healthy and 2 when
 * exhausted, but `current_weekly_status` was observed sitting on **3** while
 * `current_weekly_remaining_percent` read **100**. The weekly vocabulary is
 * therefore not shared with the interval's and cannot be mapped without
 * actually hitting the wall, so the weekly row blocks on percentage alone and
 * keeps status for diagnostics only. Blocking on an unmapped status would halt
 * every session for no reason; the asymmetry is the safe direction.
 */
export function classifyQuota(body: string, now: number, spec: ProbeSpec): PlanStatus {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return failed(spec.provider, now, 'response was not JSON')
  }
  if (!isRecord(parsed)) {
    return failed(spec.provider, now, 'response was not a JSON object')
  }

  const remains = parsed['model_remains']
  if (!Array.isArray(remains)) {
    return failed(spec.provider, now, 'model_remains was missing or not an array')
  }

  const rows: WindowRow[] = []
  for (const raw of remains) {
    if (!isRecord(raw)) continue
    const entry = raw['model_name']
    if (typeof entry !== 'string' || entry.length === 0) continue

    const pct = narrowPercent(raw['current_interval_remaining_percent'])
    rows.push({
      entry,
      window: '5h',
      blocked: narrowNumber(raw['current_interval_status']) === STATUS_EXHAUSTED || pct === 0,
      remainingPercent: pct,
      resetAt: narrowCountdown(raw['remains_time'], now),
    })

    const weeklyPct = narrowPercent(raw['current_weekly_remaining_percent'])
    rows.push({
      entry,
      window: 'weekly',
      // Percentage only. `current_weekly_status` is deliberately NOT consulted.
      blocked: weeklyPct === 0,
      remainingPercent: weeklyPct,
      resetAt: narrowCountdown(raw['weekly_remains_time'], now),
    })
  }

  // An empty parse that found no interval row is a failure, not a healthy
  // reading. Returning it as healthy would arm the wake edge permanently.
  const sawEntry = rows.some(row => row.entry === spec.entry)
  if (!sawEntry) {
    return failed(spec.provider, now, `no \`${spec.entry}\` entry in model_remains`)
  }

  return { provider: spec.provider, checkedAt: now, rows, error: null }
}
