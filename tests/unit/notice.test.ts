import { describe, expect, it } from 'vitest'
import { blockedPhrase, noticeSummary, noticeText } from '../../src/notice.js'
import type { NoticeFacts } from '../../src/notice.js'
import type { PlanStatus, WindowRow } from '../../src/types.js'

const NOW = 1_700_000_000_000
const spec = { entry: 'general', videoModelPatterns: [/^video-/i], videoEntry: 'video' }

/** Healthy rows: the reset already happened, which is the whole point. */
function row(over: Partial<WindowRow> = {}): WindowRow {
  return { entry: 'general', window: '5h', blocked: false, remainingPercent: 100, resetAt: NOW + 4 * 3_600_000, ...over }
}

function facts(over: Partial<NoticeFacts> = {}): NoticeFacts {
  return {
    provider: 'minimax-cn',
    model: 'MiniMax-M3',
    spec,
    record: {
      window: '5h',
      model: 'MiniMax-M3',
      since: NOW - 42 * 60_000,
      code: 'PROVIDER_ERROR',
      message: 'usage limit exceeded',
    },
    status: { provider: 'minimax-cn', checkedAt: NOW, rows: [row()], error: null },
    ...over,
  }
}

describe('blockedPhrase', () => {
  // MUTATION: derive the window from the current status instead of the record.
  it('names the window from the record, since the status reads healthy by now', () => {
    expect(blockedPhrase(facts())).toBe('the 5-hour usage window')
    expect(blockedPhrase(facts({ record: { ...facts().record, window: 'weekly' } })))
      .toBe('the weekly usage window')
  })
})

describe('noticeSummary', () => {
  it('states what happened in one line', () => {
    expect(noticeSummary(facts()))
      .toBe('minimax-cn 5-hour usage window reset — blocked work may resume')
  })
})

describe('noticeText', () => {
  // MUTATION: drop the failure code from the announcement.
  it('announces the reset, quotes what blocked it, and points at resuming', () => {
    const text = noticeText(facts())
    expect(text).toContain('the 5-hour usage window has reset')
    expect(text).toContain('PROVIDER_ERROR — usage limit exceeded')
    expect(text).toContain('giving you 4h of fresh window before it fills again')
    expect(text).toContain('42m of that window being exhausted')
    expect(text).toContain('pick it up exactly where it stopped')
    expect(text).toContain('If it was not, carry on')
  })

  // MUTATION: keep the optional runway clause unconditionally.
  it('omits the runway clause when the window reports no countdown', () => {
    const text = noticeText(facts({
      status: { provider: 'minimax-cn', checkedAt: NOW, rows: [row({ resetAt: null })], error: null },
    }))
    expect(text).not.toContain('fresh window')
    expect(text).toContain('Your provider is reachable again.')
  })

  // MUTATION: assert the model should always resume.
  it('leaves resuming conditional, because the work may not have been quota work', () => {
    const text = noticeText(facts())
    expect(text).toContain('If the work you were doing was cut short')
    expect(text).toContain('If it was not')
  })
})
