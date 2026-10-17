import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createQuotaNotice } from '../../src/message.js'

/**
 * The oracle.
 *
 * `createQuotaNotice` builds the announcement without a runtime dsh-llm
 * import, so this file imports the sanctioned constructor as a TEST-ONLY
 * dependency and asserts the two agree. That is what keeps the hand-rolled
 * literal honest: if `createUserMessage` ever changes shape, this goes red
 * instead of the divergence surfacing as a malformed message at runtime.
 */
describe('createQuotaNotice', () => {
  // MUTATION: swap the role or the source kind.
  it('is structurally identical to the sanctioned constructor', () => {
    const mine = createQuotaNotice('the 5-hour window has reset', 'reset')
    const theirs = createUserMessage({
      content: [{ type: 'text', text: 'the 5-hour window has reset' }],
      source: { kind: 'quota-notice', form: 'notice', summary: 'reset' },
    })

    // Identity differs by design; everything else must not.
    expect({ ...mine, id: 'ID' }).toEqual({ ...theirs, id: 'ID' })
    expect(mine.role).toBe('user')
    expect(mine.source.kind).toBe('quota-notice')
    expect(mine.source.form).toBe('notice')
  })

  // MUTATION: return a plain mutable object literal.
  it('is frozen all the way to the content block, as the real constructor is', () => {
    const message = createQuotaNotice('body', 'summary')
    expect(Object.isFrozen(message)).toBe(true)
    expect(Object.isFrozen(message.content)).toBe(true)
    expect(Object.isFrozen(message.content[0])).toBe(true)
  })

  // MUTATION: return a constant id.
  it('gives every announcement a distinct identity', () => {
    const first = createQuotaNotice('same body', 'same summary')
    const second = createQuotaNotice('same body', 'same summary')
    expect(first.id).not.toBe(second.id)
    expect(typeof first.id).toBe('string')
  })
})
