import { describe, expect, it } from 'vitest'
import z from '@deepseek-ai/schemastery'
import { Config, definePlan } from '../../src/config.js'
import type { QuotaConfig } from '../../src/config.js'

function valid(over: Partial<QuotaConfig> = {}): QuotaConfig {
  // `resolve` fills defaults and coerces. Validating a *missing required
  // field* is the Loader's job at mount time, and is covered by the harness
  // case in increment 5 — not here.
  const [output] = z.resolve({
    provider: 'minimax-cn',
    endpoint: 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains',
    authEnv: 'MINIMAX_API_KEY',
    ...over,
  }, Config, {})
  return output as QuotaConfig
}

describe('Config', () => {
  // MUTATION: drop the `entry` default.
  it('fills every default a deployment would otherwise have to spell out', () => {
    const config = valid()
    expect(config.entry).toBe('general')
    expect(config.readAttempts).toBe(3)
    expect(config.credentialFile).toBe('~/.mmx/config.json')
    expect(config.requestTimeoutMs).toBe(15_000)
    expect(config.lowWaterMarkPercent).toBe(20)
    expect(config.schedule.divisor).toBe(4)
    expect(config.schedule.minIntervalMs).toBe(15_000)
    // Guards the hand-written QuotaConfig against schema drift: definePlan
    // reads all of these, so a field present in one and missing from the
    // other must fail here rather than arriving as undefined at runtime.
    expect(Object.keys(config).sort()).toEqual([
      'authEnv', 'blockPatterns', 'credentialFile', 'endpoint', 'entry',
      'lowWaterMarkPercent', 'markerPath', 'provider', 'readAttempts',
      'requestTimeoutMs', 'schedule', 'videoEntry', 'videoModelPatterns',
    ])
    expect(Object.keys(config.schedule).sort()).toEqual([
      'baseBackoffMs', 'divisor', 'jitterRatio', 'maxBackoffMs',
      'maxIntervalMs', 'minIntervalMs', 'skewMs',
    ])
    expect(config.blockPatterns).toContain('usage limit exceeded')
    expect(config.blockPatterns).toContain('\\b2056\\b')
  })

  // MUTATION: give maxIntervalMs the same default as minIntervalMs.
  it('defaults the interval ceiling above the floor, or the countdown cannot tighten', () => {
    const config = valid()
    expect(config.schedule.maxIntervalMs).toBeGreaterThan(config.schedule.minIntervalMs)
  })

  // MUTATION: give maxIntervalMs the same default as minIntervalMs.
  it('declares provider, endpoint and authEnv as required, with no fallback', () => {
    const [output] = z.resolve({}, Config, {}) as [Record<string, unknown>]
    expect(Object.keys(output)).not.toContain('provider')
    expect(Object.keys(output)).not.toContain('endpoint')
    expect(Object.keys(output)).not.toContain('authEnv')
  })
})

describe('definePlan', () => {
  // MUTATION: swallow an invalid pattern instead of failing the load.
  it('fails the load loudly on a pattern that cannot compile', () => {
    expect(() => definePlan(valid({ blockPatterns: ['(unclosed'] }))).toThrow(/invalid pattern/)
    expect(() => definePlan(valid({ videoModelPatterns: ['*'] }))).toThrow(/invalid pattern/)
  })

  // MUTATION: drop the endpoint URL check.
  it('fails the load loudly on an endpoint that is not a URL', () => {
    expect(() => definePlan(valid({ endpoint: 'not a url' }))).toThrow(/not a URL/)
  })

  // MUTATION: drop the case-insensitive flag.
  it('compiles patterns case-insensitively', () => {
    const plan = definePlan(valid({ blockPatterns: ['USAGE LIMIT EXCEEDED'] }))
    expect(plan.blockPatterns[0]?.test('usage limit exceeded')).toBe(true)
  })

  // MUTATION: hardcode the provider instead of reading config.
  it('threads config through to the probe and the scheduler', () => {
    const plan = definePlan(valid({ provider: 'other', entry: 'general', schedule: { divisor: 7 } as never }))
    expect(plan.probe).toEqual({ provider: 'other', entry: 'general' })
    expect(plan.schedule.divisor).toBe(7)
  })
})
