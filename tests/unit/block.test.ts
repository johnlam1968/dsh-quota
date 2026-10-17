import { describe, expect, it } from 'vitest'
import { matchesBlock } from '../../src/block.js'

const LIMIT = /usage limit exceeded/i
const CODE = /\b2056\b/

const EXHAUSTED = {
  code: 'PROVIDER_ERROR',
  status: 400,
  message: '2056 usage limit exceeded: Please wait for the resource release in the next 5-hour window',
}

describe('matchesBlock', () => {
  it('recognises the provider usage-limit failure', () => {
    expect(matchesBlock(EXHAUSTED, [LIMIT, CODE])).toBe(true)
  })

  // MUTATION: drop the code from the haystack.
  it('finds the code even when the wording changes', () => {
    expect(matchesBlock({ code: 'X', message: 'error 2056 returned' }, [CODE])).toBe(true)
  })

  it('finds a numeric code that arrived as an HTTP status', () => {
    expect(matchesBlock({ code: 'X', status: 2056, message: 'nope' }, [CODE])).toBe(true)
  })

  it('does not match an unrelated failure', () => {
    expect(matchesBlock({ code: 'TIMEOUT', status: 504, message: 'upstream timed out' }, [LIMIT, CODE])).toBe(false)
  })

  // MUTATION: return true when no patterns are configured.
  it('matches nothing when no pattern is configured', () => {
    expect(matchesBlock(EXHAUSTED, [])).toBe(false)
  })

  // MUTATION: delete the `pattern.lastIndex = 0` reset.
  it('is stable across repeated calls with a stateful /g pattern', () => {
    const stateful = /usage limit exceeded/gi
    const patterns = [stateful]
    expect(matchesBlock(EXHAUSTED, patterns)).toBe(true)
    expect(matchesBlock(EXHAUSTED, patterns)).toBe(true)
    expect(matchesBlock(EXHAUSTED, patterns)).toBe(true)
  })

  // MUTATION: share one regex object across two sessions' checks.
  it('does not leak lastIndex between distinct callers sharing a pattern', () => {
    const shared = /usage limit exceeded/i
    expect(matchesBlock(EXHAUSTED, [shared])).toBe(true)
    expect(matchesBlock({ code: 'X', message: 'nothing here' }, [shared])).toBe(false)
    expect(matchesBlock(EXHAUSTED, [shared])).toBe(true)
  })
})
