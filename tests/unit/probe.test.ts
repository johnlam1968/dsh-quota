import { describe, expect, it } from 'vitest'
import { classifyQuota } from '../../src/probe.js'
import type { ProbeSpec } from '../../src/probe.js'

const NOW = 1_700_000_000_000
const spec: ProbeSpec = { provider: 'minimax-cn', entry: 'general' }

function response(entry: Record<string, unknown>): string {
  return JSON.stringify({ model_remains: [entry] })
}

const HEALTHY = {
  model_name: 'general',
  current_interval_status: 1,
  current_interval_remaining_percent: 42,
  remains_time: 60_000,
  current_weekly_status: 1,
  current_weekly_remaining_percent: 100,
  weekly_remains_time: 600_000_000,
}

describe('classifyQuota', () => {
  it('reports a healthy interval as unblocked with an absolute reset time', () => {
    const status = classifyQuota(response(HEALTHY), NOW, spec)
    expect(status.error).toBeNull()
    expect(status.rows).toHaveLength(2) // 5h + weekly, one pair per entry
    const interval = status.rows[0]
    expect(interval?.window).toBe('5h')
    expect(interval?.blocked).toBe(false)
    expect(interval?.remainingPercent).toBe(42)
    // Absolute, not a duration: the scheduler compares it against a clock.
    expect(interval?.resetAt).toBe(NOW + 60_000)
    expect(status.rows[1]?.window).toBe('weekly')
  })

  // MUTATION: drop `|| pct === 0` from the blocked derivation.
  it('treats zero remaining percent as blocked even when status disagrees', () => {
    const status = classifyQuota(
      response({ ...HEALTHY, current_interval_status: 1, current_interval_remaining_percent: 0 }),
      NOW,
      spec,
    )
    expect(status.rows[0]?.blocked).toBe(true)
  })

  // MUTATION: replace `status === STATUS_BLOCKED` with a truthiness check.
  it('treats the provider status marker as blocked', () => {
    const status = classifyQuota(
      response({ ...HEALTHY, current_interval_status: 2, current_interval_remaining_percent: 99 }),
      NOW,
      spec,
    )
    expect(status.rows[0]?.blocked).toBe(true)
  })

  // MUTATION: return the status with rows:[] dropped, so a failed read looks healthy.
  it.each([
    ['not JSON', 'not json at all'],
    ['a JSON array', '[]'],
    ['a JSON scalar', '42'],
    ['an object without model_remains', '{"base_resp":{}}'],
    ['an entry that is not an object', '{"model_remains":[7]}'],
    ['a row with no model_name', '{"model_remains":[{"current_interval_status":2}]}'],
  ])('fails with no rows when the response is %s', (_label, body) => {
    const status = classifyQuota(body, NOW, spec)
    expect(status.error).not.toBeNull()
    expect(status.rows).toEqual([])
  })

  // MUTATION: delete the `sawEntry` guard.
  it('fails when the account entry is absent rather than reading as healthy', () => {
    const body = JSON.stringify({
      model_remains: [{ model_name: 'some-other-model', current_interval_status: 1 }],
    })
    const status = classifyQuota(body, NOW, spec)
    expect(status.error).toContain('general')
    expect(status.rows).toEqual([])
  })

  // MUTATION: read `resetAt` from a raw countdown instead of adding `now`.
  it('rejects a non-positive or non-finite countdown instead of trusting it', () => {
    for (const remains of [0, -1, Number.NaN, '60000', null, undefined]) {
      const status = classifyQuota(response({ ...HEALTHY, remains_time: remains }), NOW, spec)
      expect(status.error).toBeNull()
      expect(status.rows[0]?.resetAt).toBeNull()
    }
  })

  // MUTATION: widen the isRecord guard to accept arrays.
  // MUTATION: consult `current_weekly_status` for the block decision.
  it('never blocks the weekly window on its status alone', () => {
    // Measured live: current_weekly_status was 3 while remaining_percent was
    // 100. The weekly vocabulary is not the interval's, so status cannot block.
    const status = classifyQuota(
      response({ ...HEALTHY, current_weekly_status: 3, current_weekly_remaining_percent: 100 }),
      NOW,
      spec,
    )
    expect(status.error).toBeNull()
    const weekly = status.rows.find(row => row.window === 'weekly')
    expect(weekly?.remainingPercent).toBe(100)
    expect(weekly?.blocked).toBe(false)
  })

  // MUTATION: drop `weeklyPct === 0` from the weekly block decision.
  it('blocks the weekly window on zero percent', () => {
    const status = classifyQuota(
      response({ ...HEALTHY, current_weekly_remaining_percent: 0 }),
      NOW,
      spec,
    )
    expect(status.rows.find(row => row.window === 'weekly')?.blocked).toBe(true)
  })

  it('reads the weekly countdown into an absolute instant', () => {
    const status = classifyQuota(response(HEALTHY), NOW, spec)
    expect(status.rows.find(row => row.window === 'weekly')?.resetAt).toBe(NOW + 600_000_000)
  })

  // MUTATION: drop the second entry, losing video budgets entirely.
  it('narrows every account entry, not only the account-wide one', () => {
    const body = JSON.stringify({
      model_remains: [HEALTHY, { ...HEALTHY, model_name: 'video' }],
    })
    const status = classifyQuota(body, NOW, spec)
    expect(status.error).toBeNull()
    expect(new Set(status.rows.map(r => r.entry))).toEqual(new Set(['general', 'video']))
  })

  it('keeps a usable reading when extra unusable rows are present', () => {
    const body = JSON.stringify({
      model_remains: [7, null, 'nope', { no_model_name: true }, HEALTHY],
    })
    const status = classifyQuota(body, NOW, spec)
    expect(status.error).toBeNull()
    expect(status.rows).toHaveLength(2)
  })
})
