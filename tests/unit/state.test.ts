import { describe, expect, it } from 'vitest'
import { EMPTY_STATE, settle, withBlock, withoutBlock } from '../../src/state.js'
import type { QuotaState } from '../../src/state.js'
import type { PlanStatus, WindowRow } from '../../src/types.js'
import type { BlockRecord } from '../../src/types.js'
import { SessionId } from '@deepseek-ai/dsh-session'

const NOW = 1_700_000_000_000
const spec = { entry: 'general', videoModelPatterns: [/^video-/i], videoEntry: 'video' }
const S1 = SessionId('session-one')
const S2 = SessionId('session-two')

function row(over: Partial<WindowRow> = {}): WindowRow {
  return { entry: 'general', window: '5h', blocked: false, remainingPercent: 100, resetAt: NOW + 3_600_000, ...over }
}

function status(over: Partial<PlanStatus> = {}): PlanStatus {
  return { provider: 'minimax-cn', checkedAt: NOW, rows: [], error: null, ...over }
}

function record(over: Partial<BlockRecord> = {}): BlockRecord {
  return { window: '5h', model: 'm1', since: NOW - 3_600_000, code: 'E', message: 'usage limit exceeded', ...over }
}

function blocked(entries: Array<[string, Partial<BlockRecord>?]> = [[S1]]): QuotaState {
  return withBlock(
    { ...EMPTY_STATE, status: status({ rows: [row({ blocked: true, remainingPercent: 0 })] }) },
    SessionId(entries[0]![0]),
    record(entries[0]![1]),
  )
}

describe('settle — the reset edge', () => {
  // MUTATION: always speak when the model is now usable.
  it('fires exactly once, on the unusable -> usable transition', () => {
    const before = blocked()
    const after = settle(before, status({ rows: [row()] }), 'minimax-cn', spec)
    expect(after.notices.map(n => n.sessionId)).toEqual([S1])
    expect(after.notices[0]?.facts.provider).toBe('minimax-cn')
    // The record is consumed, so the next probe cannot fire a second wake.
    expect(after.state.blockedAgents.size).toBe(0)
    const third = settle(after.state, status({ rows: [row()] }), 'minimax-cn', spec)
    expect(third.notices).toEqual([])
  })

  // MUTATION: evaluate the edge against the incoming status on both sides.
  it('does not fire when the model was already usable', () => {
    const before = { ...EMPTY_STATE, status: status({ rows: [row()] }) }
    const withRecord = withBlock(before, S1, record())
    const after = settle(withRecord, status({ rows: [row()] }), 'minimax-cn', spec)
    expect(after.notices).toEqual([])
    expect(after.state.blockedAgents.size).toBe(0)
  })

  // MUTATION: drop the `if (!usableNow)` keep branch.
  it('keeps a record while the model is still blocked and says nothing', () => {
    const before = blocked()
    const after = settle(before, status({ rows: [row({ blocked: true, remainingPercent: 0 })] }), 'minimax-cn', spec)
    expect(after.notices).toEqual([])
    expect(after.state.blockedAgents.has(S1)).toBe(true)
  })

  // MUTATION: read the window state once for the account instead of per record.
  it('wakes each session on its own window, not on one account-level flag', () => {
    const before = withBlock(
      withBlock(
        { ...EMPTY_STATE, status: status({ rows: [row({ window: '5h', blocked: true, remainingPercent: 0 }), row({ window: 'weekly', blocked: true })] }) },
        S1,
        record({ model: 'm1', window: '5h' }),
      ),
      S2,
      record({ model: 'video-x', window: 'weekly' }),
    )

    // Only the weekly window recovered; the text model is still blocked.
    const partial = settle(before, status({ rows: [row({ window: '5h', blocked: true, remainingPercent: 0 }), row({ window: 'weekly' })] }), 'minimax-cn', spec)
    expect(partial.notices.map(n => n.sessionId)).toEqual([S2])
    expect(partial.state.blockedAgents.has(S1)).toBe(true)

    // Now both have.
    const full = settle(partial.state, status({ rows: [row(), row({ window: 'weekly' })] }), 'minimax-cn', spec)
    expect(full.notices.map(n => n.sessionId)).toEqual([S1])
    expect(full.state.blockedAgents.size).toBe(0)
  })

  // MUTATION: deliver notices for blocked sessions with no record.
  it('does not wake a session that was never blocked', () => {
    const after = settle(EMPTY_STATE, status({ rows: [row()] }), 'minimax-cn', spec)
    expect(after.notices).toEqual([])
  })
})

describe('settle — failed reads', () => {
  // MUTATION: let a failed read clear the blocked records.
  it('changes nothing but the streak when a read fails', () => {
    const before = blocked()
    const after = settle(before, status({ error: 'timeout' }), 'minimax-cn', spec)
    expect(after.notices).toEqual([])
    expect(after.state.blockedAgents.has(S1)).toBe(true)
    expect(after.state.errorStreak).toBe(1)
    // The last good reading survives the failure rather than being replaced.
    expect(after.state.status?.error).toBeNull()
    expect(after.state.status?.rows[0]?.blocked).toBe(true)
    expect(after.accountBlocked).toBe(false)
  })

  // MUTATION: clear the streak on a failed read.
  it('accumulates the streak across consecutive failures', () => {
    let state = blocked()
    for (const expected of [1, 2, 3]) {
      state = settle(state, status({ error: 'timeout' }), 'minimax-cn', spec).state
      expect(state.errorStreak).toBe(expected)
    }
  })

  // MUTATION: overwrite the last good status with the failed read.
  it('still wakes a blocked session after an outage, not before', () => {
    const failed = settle(blocked(), status({ error: 'timeout' }), 'minimax-cn', spec).state
    const good = settle(failed, status({ rows: [row()] }), 'minimax-cn', spec)
    expect(good.state.errorStreak).toBe(0)
    expect(good.notices.map(n => n.sessionId)).toEqual([S1])
  })

  // MUTATION: treat a failed read as a usable reading.
  it('cannot announce a reset off a read that never happened', () => {
    const before: QuotaState = { ...EMPTY_STATE, status: null }
    const withRecord = withBlock(before, S1, record())
    const after = settle(withRecord, status({ error: 'timeout' }), 'minimax-cn', spec)
    expect(after.notices).toEqual([])
  })
})

describe('settle — accountBlocked', () => {
  // MUTATION: derive it from any model row instead of the account entry.
  it('is true while the account entry itself is exhausted', () => {
    expect(settle(EMPTY_STATE, status({ rows: [row({ blocked: true, remainingPercent: 0 })] }), 'p', spec).accountBlocked).toBe(true)
    expect(settle(EMPTY_STATE, status({ rows: [row()] }), 'p', spec).accountBlocked).toBe(false)
  })

  // MUTATION: read it from the last known status instead of the new one.
  it('is false for a failed read rather than freezing the last answer', () => {
    expect(settle(blocked(), status({ error: 'timeout' }), 'p', spec).accountBlocked).toBe(false)
  })
})

describe('withBlock / withoutBlock', () => {
  // MUTATION: mutate the passed map in place.
  it('does not mutate the state it was given', () => {
    const before = blocked()
    const snapshot = new Map(before.blockedAgents)
    const after = withBlock(before, S2, record())
    expect(after).not.toBe(before)
    expect(before.blockedAgents).toEqual(snapshot)
    expect(after.blockedAgents.size).toBe(2)
  })

  // MUTATION: return the same object when the session is absent.
  it('forgets a session and leaves an absent one alone', () => {
    const before = blocked()
    const after = withoutBlock(before, S1)
    expect(after.blockedAgents.size).toBe(0)
    expect(withoutBlock(after, S1)).toBe(after)
  })

  // MUTATION: append instead of replacing.
  it('replaces an earlier record for the same session', () => {
    const first = withBlock(EMPTY_STATE, S1, record({ since: NOW - 9_000 }))
    const second = withBlock(first, S1, record({ since: NOW }))
    expect(second.blockedAgents.size).toBe(1)
    expect(second.blockedAgents.get(S1)?.since).toBe(NOW)
  })
})
