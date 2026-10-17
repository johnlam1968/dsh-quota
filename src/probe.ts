import type { PlanStatus, WindowRow } from './types.js'

/** What the probe needs to know about the plan it is reading. */
export interface ProbeSpec {
  readonly provider: string
  /** The `model_name` carrying the account-wide rolling interval. */
  readonly entry: string
}

/** The provider's "interval exhausted" marker on `current_interval_status`. */
const STATUS_BLOCKED = 2

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

/**
 * Narrow one provider response into detached rows.
 *
 * Never throws and never partially succeeds: every failure path returns a
 * status whose only populated field is `error`. The endpoint is untrusted
 * input, so every field is narrowed by an explicit check and nothing is cast.
 *
 * Only the rolling 5-hour interval is read. The provider reports weekly
 * headroom separately and it can read 100% while the interval is blocked, so
 * inferring a block from it would be wrong in both directions. Until the
 * weekly field path is confirmed against a live response, `derive.ts` treats
 * an absent weekly row as "not blocked" — the conservative direction, since
 * only a confirmed row ever blocks.
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

    const status = raw['current_interval_status']
    const percent = raw['current_interval_remaining_percent']
    const remainsMs = raw['remains_time']

    const pct = isFiniteNumber(percent) ? percent : null
    const resetAt = isPositiveCountdown(remainsMs) ? now + remainsMs : null

    rows.push({
      entry,
      window: '5h',
      blocked: status === STATUS_BLOCKED || pct === 0,
      remainingPercent: pct,
      resetAt,
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
