import { describe, expect, it } from 'vitest'
import { jittered, nextDelay } from '../../src/schedule.js'
import type { ScheduleConfig } from '../../src/schedule.js'
import type { PlanStatus, WindowRow } from '../../src/types.js'

const NOW = 1_700_000_000_000
const SALT = 0.5 // identity jitter

const cfg: ScheduleConfig = {
  divisor: 4,
  minIntervalMs: 15_000,
  maxIntervalMs: 900_000,
  skewMs: 30_000,
  baseBackoffMs: 1_000,
  maxBackoffMs: 300_000,
  jitterRatio: 0.1,
}

function status(over: Partial<PlanStatus> = {}): PlanStatus {
  return { provider: 'minimax-cn', checkedAt: NOW, rows: [], error: null, ...over }
}

function blockedRow(resetAt: number | null): WindowRow {
  return { entry: 'general', window: '5h', blocked: true, remainingPercent: 0, resetAt }
}

function delay(s: PlanStatus, usable: boolean, streak = 0, salt = SALT): number {
  return nextDelay(s, usable, NOW, cfg, streak, salt).delayMs
}

const tenMinutes = (): number => 10 * 60 * 1000

describe('nextDelay', () => {
  // MUTATION: remove the `status.error !== null` branch.
  it('backs off on a failed read without consulting the provider state', () => {
    const failed = status({ error: 'timeout' })
    expect(nextDelay(failed, true, NOW, cfg, 0, SALT).reason).toBe('read-failed')
    expect(delay(failed, true, 0)).toBe(1_000)
  })

  // MUTATION: remove the `2 ** errorStreak` doubling.
  it('doubles the backoff per consecutive failure and caps it', () => {
    const failed = status({ error: 'timeout' })
    expect(delay(failed, true, 1)).toBe(2_000)
    expect(delay(failed, true, 2)).toBe(4_000)
    expect(delay(failed, true, 20)).toBe(cfg.maxBackoffMs)
  })

  // MUTATION: probe at minIntervalMs when healthy.
  it('probes at the healthy cadence when usable', () => {
    expect(nextDelay(status(), true, NOW, cfg, 0, SALT).reason).toBe('usable')
    expect(delay(status(), true)).toBe(cfg.maxIntervalMs)
  })

  // MUTATION: divide by 1, which restores per-interval polling.
  it('caps a long wait at the healthy cadence', () => {
    const fourHours = 4 * 60 * 60 * 1000
    const s = status({ rows: [blockedRow(NOW + fourHours)] })
    const result = nextDelay(s, false, NOW, cfg, 0, SALT)
    expect(result.reason).toBe('counting-down')
    // 4h / 4 would be 1h, above the ceiling, so the ceiling binds.
    expect(result.delayMs).toBe(cfg.maxIntervalMs)
    // 16 probes for a four-hour wait, against 960 at the 15s floor.
    expect(fourHours / result.delayMs).toBe(16)
  })

  // MUTATION: replace `until / divisor` with `until`.
  it('divides the wait evenly so the final slice lands on the boundary', () => {
    const fortyMinutes = 40 * 60 * 1000
    const s = status({ rows: [blockedRow(NOW + fortyMinutes)] })
    const result = nextDelay(s, false, NOW, cfg, 0, SALT)
    expect(result.delayMs).toBe(tenMinutes())
    // Four slices reach the boundary exactly; without the divisor the last
    // probe would land 5 minutes past it.
    expect(fortyMinutes % result.delayMs).toBe(0)
  })

  // MUTATION: delete both clamps.
  it('clamps a slice into the configured interval bounds', () => {
    const near = status({ rows: [blockedRow(NOW + 40_000)] })
    // 40s / 4 = 10s, below the floor -> floor.
    expect(delay(near, false)).toBe(cfg.minIntervalMs)

    const veryNear = status({ rows: [blockedRow(NOW + 5_000)] })
    expect(nextDelay(veryNear, false, NOW, cfg, 0, SALT).reason).toBe('boundary-now')
    expect(delay(veryNear, false)).toBe(cfg.skewMs)
  })

  // MUTATION: spin on a short interval when blocked with no countdown.
  it('falls back to the healthy cadence when a block has no countdown', () => {
    const s = status({ rows: [blockedRow(null)] })
    expect(nextDelay(s, false, NOW, cfg, 0, SALT).reason).toBe('blocked-no-countdown')
    expect(delay(s, false)).toBe(cfg.maxIntervalMs)
  })

  // MUTATION: schedule off the earliest blocked boundary only.
  it('schedules against the earliest blocking boundary', () => {
    const s = status({
      rows: [blockedRow(NOW + 9_000_000), blockedRow(NOW + 120_000)],
    })
    // 120s / 4 = 30s, above the floor -> the later row must not win.
    expect(delay(s, false)).toBe(30_000)
  })
})

describe('jittered', () => {
  // MUTATION: make jitter a no-op, so every host sharing an account probes
  // at the same instant.
  it('is the identity at salt 0.5 and spreads at the extremes', () => {
    expect(jittered(1000, 0.1, 0.5)).toBe(1000)
    expect(jittered(1000, 0.1, 0)).toBe(900)
    expect(jittered(1000, 0.1, 1)).toBe(1100)
  })

  it('never returns a non-positive delay', () => {
    expect(jittered(1, 5, 0)).toBeGreaterThanOrEqual(1)
  })
})
