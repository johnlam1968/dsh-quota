import { describe, expect, it } from 'vitest'
import { deriveUsable, effectiveRows, isUsable, nextResetAt, rowFor } from '../../src/derive.js'
import type { DeriveSpec } from '../../src/derive.js'
import type { PlanStatus, WindowRow } from '../../src/types.js'

const spec: DeriveSpec = { entry: 'general', videoModelPatterns: [/^video-/i], videoEntry: 'video' }
const NOW = 1_700_000_000_000

function row(over: Partial<WindowRow> = {}): WindowRow {
  return { entry: 'general', window: '5h', blocked: false, remainingPercent: 50, resetAt: null, ...over }
}

describe('deriveUsable', () => {
  it('blocks a text model whose 5-hour interval is exhausted', () => {
    expect(deriveUsable([row({ blocked: true })], 'MiniMax-M3', spec)).toBe(false)
  })

  // MUTATION: drop the video exemption from windowsFor.
  it('leaves a video model usable while only its 5-hour interval is exhausted', () => {
    expect(deriveUsable([row({ blocked: true })], 'video-gen-1', spec)).toBe(true)
  })

  // MUTATION: invert `?.blocked !== true` to `=== true`.
  it('blocks a video model whose weekly window is exhausted', () => {
    const rows = [row({ blocked: false }), row({ window: 'weekly', blocked: true })]
    expect(deriveUsable(rows, 'video-gen-1', spec)).toBe(false)
  })

  // MUTATION: make a missing row count as blocked.
  it('treats an unread weekly window as not blocking', () => {
    expect(deriveUsable([row({ blocked: false })], 'MiniMax-M3', spec)).toBe(true)
  })

  // MUTATION: ignore the video entry and let video models read the account row.
  it("reads a video model's budget from the video entry, not the account row", () => {
    const rows = [
      // The text model is out. A video model must not inherit that.
      row({ entry: 'general', window: '5h', blocked: true, remainingPercent: 0 }),
      row({ entry: 'general', window: 'weekly' }),
      row({ entry: 'video', window: '5h', blocked: true, remainingPercent: 0 }),
      row({ entry: 'video', window: 'weekly', remainingPercent: 90 }),
    ]
    // Weekly-only, and its own entry's weekly row is healthy.
    expect(deriveUsable(rows, 'video-gen-1', spec)).toBe(true)
    // The same rows with the video entry exhausted do block it.
    const exhausted = [...rows]
    exhausted[3] = row({ entry: 'video', window: 'weekly', blocked: true, remainingPercent: 0 })
    expect(deriveUsable(exhausted, 'video-gen-1', spec)).toBe(false)
  })

  // MUTATION: drop the model-specific precedence from rowFor.
  it('prefers the routed model row over the account-wide row', () => {
    const rows = [
      row({ entry: 'general', window: '5h', blocked: true }),
      row({ entry: 'MiniMax-M3', window: '5h', blocked: false }),
    ]
    expect(deriveUsable(rows, 'MiniMax-M3', spec)).toBe(true)
    // The account row still governs a model with no row of its own.
    expect(deriveUsable(rows, 'other-model', spec)).toBe(false)
  })

  // MUTATION: fall back to the account row when a model-specific row exists.
  it('does not let the account row override a model that reports its own', () => {
    const rows = [
      row({ entry: 'general', blocked: true }),
      row({ entry: 'MiniMax-M3', blocked: false }),
    ]
    expect(rowFor(rows, 'MiniMax-M3', spec, '5h')?.entry).toBe('MiniMax-M3')
  })
})

describe('effectiveRows', () => {
  it('returns exactly the rows that gated the model, in window order', () => {
    const rows = [
      row({ window: 'weekly' }),
      row({ window: '5h' }),
      row({ entry: 'ignored', window: '5h' }),
    ]
    expect(effectiveRows(rows, 'MiniMax-M3', spec).map(r => r.window)).toEqual(['5h', 'weekly'])
    expect(effectiveRows(rows, 'video-gen-1', spec).map(r => r.window)).toEqual(['weekly'])
  })
})

describe('nextResetAt', () => {
  // MUTATION: return the latest blocked reset instead of the earliest.
  it('returns the soonest blocking boundary and ignores unblocked rows', () => {
    const rows = [
      row({ blocked: true, resetAt: NOW + 900_000 }),
      row({ blocked: true, resetAt: NOW + 300_000 }),
      row({ blocked: false, resetAt: NOW + 100_000 }),
      row({ blocked: true, resetAt: null }),
    ]
    expect(nextResetAt(rows)).toBe(NOW + 300_000)
  })

  it('returns null when nothing blocked has a countdown', () => {
    expect(nextResetAt([row({ resetAt: null })])).toBeNull()
  })
})

describe('isUsable', () => {
  const status: PlanStatus = { provider: 'p', checkedAt: NOW, rows: [row({ blocked: true })], error: null }

  // MUTATION: return false for an unread plan, which would tell every session
  // it is blocked before the first probe has ever succeeded.
  it('does not claim a plan is blocked before it has been read', () => {
    expect(isUsable(null, 'MiniMax-M3', spec)).toBe(true)
    expect(isUsable({ ...status, rows: [], error: 'boom' }, 'MiniMax-M3', spec)).toBe(true)
    expect(isUsable(status, 'MiniMax-M3', spec)).toBe(false)
  })
})
