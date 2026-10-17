import { describe, expect, it } from 'vitest'
import { formatDuration, renderQuotaStatus, windowLabel } from '../../src/format.js'
import type { DeriveSpec } from '../../src/derive.js'
import type { PlanStatus, WindowRow } from '../../src/types.js'

const NOW = 1_700_000_000_000
const spec: DeriveSpec = { entry: 'general', videoModelPatterns: [/^video-/i] }

function status(over: Partial<PlanStatus> = {}): PlanStatus {
  return { provider: 'minimax-cn', checkedAt: NOW, rows: [], error: null, ...over }
}

function row(over: Partial<WindowRow> = {}): WindowRow {
  return { entry: 'general', window: '5h', blocked: false, remainingPercent: 50, resetAt: null, ...over }
}

describe('formatDuration', () => {
  it.each([
    [0, '0s'],
    [45_400, '45s'],
    [60_000, '1m'],
    [90_000, '1m 30s'],
    [3 * 3_600_000, '3h'],
    [3 * 3_600_000 + 20 * 60_000, '3h 20m'],
    [48 * 3_600_000, '2d'],
    [50 * 3_600_000, '2d 2h'],
  ])('renders %ims as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected)
  })

  // MUTATION: drop the negative/non-finite guard.
  it('refuses to render a nonsense duration as a real one', () => {
    expect(formatDuration(-1)).toBe('an unknown time')
    expect(formatDuration(Number.NaN)).toBe('an unknown time')
  })
})

describe('windowLabel', () => {
  // MUTATION: swap the two labels.
  it('names each window distinctly', () => {
    expect(windowLabel('5h')).toBe('5-hour')
    expect(windowLabel('weekly')).toBe('weekly')
  })
})

describe('renderQuotaStatus', () => {
  // MUTATION: treat an unread plan as blocked.
  it('says nothing before the first successful read', () => {
    expect(renderQuotaStatus(null, 'm', spec, 20)).toBe('')
    expect(renderQuotaStatus(status({ error: 'timeout' }), 'm', spec, 20)).toBe('')
  })

  // MUTATION: always render a line.
  it('says nothing while usage is comfortable', () => {
    expect(renderQuotaStatus(status({ rows: [row({ remainingPercent: 90 })] }), 'm', spec, 20)).toBe('')
  })

  // MUTATION: move the low-water check above the usable check.
  it('speaks up once usage drops to the low-water mark', () => {
    const s = status({ rows: [row({ remainingPercent: 15 })] })
    const line = renderQuotaStatus(s, 'm', spec, 20)
    expect(line).toContain('5-hour window 15% remaining')
    expect(line).toContain('pacing')
    expect(line).not.toContain('refused')
  })

  // MUTATION: omit the countdown from the blocked line.
  it('states the block and the time to the reset', () => {
    const s = status({ rows: [row({ blocked: true, resetAt: NOW + 90 * 60_000 })] })
    const line = renderQuotaStatus(s, 'm', spec, 20)
    expect(line).toContain('5-hour window exhausted, resets 1h 30m')
    expect(line).toContain('quota limit, not a fault')
    expect(line).toContain('Do not retry in a loop')
    // Both halves of the guidance: the prohibition, and what to do instead.
    expect(line).toContain('work on something else, or wait for the reset.')
  })

  // MUTATION: drop the row-less fallback.
  it('still speaks when the block has no countdown', () => {
    const s = status({ rows: [row({ blocked: true, resetAt: null })] })
    expect(renderQuotaStatus(s, 'm', spec, 20)).toContain('5-hour window exhausted')
  })

  // MUTATION: gate on the account row instead of the routed model's rows.
  it('respects the video exemption, so a blocked 5-hour window is not a stop', () => {
    const s = status({ rows: [row({ blocked: true, remainingPercent: 0 })] })
    expect(renderQuotaStatus(s, 'video-gen-1', spec, 20)).toBe('')
  })

  it('wraps its output in a named tag so the model can scope it', () => {
    const s = status({ rows: [row({ blocked: true })] })
    expect(renderQuotaStatus(s, 'm', spec, 20)).toMatch(/^<provider-quota>.*<\/provider-quota>$/s)
  })
})
