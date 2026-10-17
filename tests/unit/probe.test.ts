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
}

describe('classifyQuota', () => {
  it('reports a healthy interval as unblocked with an absolute reset time', () => {
    const status = classifyQuota(response(HEALTHY), NOW, spec)
    expect(status.error).toBeNull()
    expect(status.rows).toHaveLength(1)
    const row = status.rows[0]
    expect(row?.blocked).toBe(false)
    expect(row?.remainingPercent).toBe(42)
    // Absolute, not a duration: the scheduler compares it against a clock.
    expect(row?.resetAt).toBe(NOW + 60_000)
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
  it('keeps a usable reading when extra unusable rows are present', () => {
    const body = JSON.stringify({
      model_remains: [7, null, 'nope', { no_model_name: true }, HEALTHY],
    })
    const status = classifyQuota(body, NOW, spec)
    expect(status.error).toBeNull()
    expect(status.rows).toHaveLength(1)
  })
})
