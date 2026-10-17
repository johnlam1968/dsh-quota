import type { SessionId } from '@deepseek-ai/dsh-session'
import type { BlockRecord, PlanStatus } from './types.js'
import { deriveUsable } from './derive.js'
import type { DeriveSpec } from './derive.js'
import type { NoticeFacts } from './notice.js'

/** One session that is owed a reset announcement. */
export interface EdgeNotice {
  readonly sessionId: SessionId
  readonly facts: NoticeFacts
}

/** Everything the settle step owns. No I/O, no clock, no Cordis. */
export interface QuotaState {
  readonly status: PlanStatus | null
  /** Sessions currently owed a reset, keyed by their live session identity. */
  readonly blockedAgents: ReadonlyMap<SessionId, BlockRecord>
  readonly errorStreak: number
}

export const EMPTY_STATE: QuotaState = {
  status: null,
  blockedAgents: new Map(),
  errorStreak: 0,
}

export interface Settlement {
  readonly state: QuotaState
  readonly notices: readonly EdgeNotice[]
  /** Whether the account itself is currently refusing requests. */
  readonly accountBlocked: boolean
}

/**
 * Fold one probe result into the state and decide who is owed an announcement.
 *
 * The edge is evaluated PER BLOCKED RECORD rather than once for the account,
 * because "usable" is a property of (rows, model) and two sessions can be
 * gated by different windows. A video session blocked on the weekly window
 * and a text session blocked on the 5-hour window must be woken by their own
 * resets, not by whichever account-level flag moved first.
 *
 * A record that survives a transition from unusable to usable stays blocked
 * and produces nothing; a record that finds the model already usable — a stale
 * entry from before a restart, or one the sweep picked up too eagerly — is
 * dropped silently. Only a real unusable -> usable transition speaks.
 */
export function settle(
  prev: QuotaState,
  next: PlanStatus,
  provider: string,
  spec: DeriveSpec,
): Settlement {
  // A read that failed says nothing about any window. Change nothing except
  // the streak, so a timeout can never be mistaken for a reset.
  //
  // Crucially the last GOOD status is kept, not overwritten with the error.
  // Replacing it would erase the fact that a session was blocked, so a single
  // dropped request in the middle of an exhaustion window would swallow the
  // reset that came after it.
  if (next.error !== null) {
    return {
      state: { status: prev.status, blockedAgents: prev.blockedAgents, errorStreak: prev.errorStreak + 1 },
      notices: [],
      accountBlocked: false,
    }
  }

  const wasReadable = prev.status !== null && prev.status.error === null
  const notices: EdgeNotice[] = []
  const blocked = new Map<SessionId, BlockRecord>()

  for (const [sessionId, record] of prev.blockedAgents) {
    const usableNow = deriveUsable(next.rows, record.model, spec)
    if (!usableNow) {
      blocked.set(sessionId, record)
      continue
    }
    const wasUsable = wasReadable
      ? deriveUsable(prev.status?.rows ?? [], record.model, spec)
      : true
    if (!wasUsable) {
      notices.push({
        sessionId,
        facts: { provider, record, status: next, model: record.model, spec },
      })
    }
    // else: the record was already stale and has now been consumed silently.
  }

  return {
    state: { status: next, blockedAgents: blocked, errorStreak: 0 },
    notices,
    accountBlocked: !deriveUsable(next.rows, spec.entry, spec),
  }
}

/** Record a session as blocked, replacing any earlier record for it. */
export function withBlock(
  state: QuotaState,
  sessionId: SessionId,
  record: BlockRecord,
): QuotaState {
  const blockedAgents = new Map(state.blockedAgents)
  blockedAgents.set(sessionId, record)
  return { ...state, blockedAgents }
}

/**
 * Drop a session's outstanding record, e.g. because it moved off this
 * provider. The failure was real, but announcing a reset for work the
 * session has since moved past is noise, and re-blocking creates a fresh
 * record anyway.
 */
export function withoutBlock(state: QuotaState, sessionId: SessionId): QuotaState {
  if (!state.blockedAgents.has(sessionId)) return state
  const blockedAgents = new Map(state.blockedAgents)
  blockedAgents.delete(sessionId)
  return { ...state, blockedAgents }
}
