import type { SessionId } from '@deepseek-ai/dsh-session';
import type { BlockRecord, PlanStatus } from './types.js';
import type { DeriveSpec } from './derive.js';
import type { NoticeFacts } from './notice.js';
/** One session that is owed a reset announcement. */
export interface EdgeNotice {
    readonly sessionId: SessionId;
    readonly facts: NoticeFacts;
}
/** Everything the settle step owns. No I/O, no clock, no Cordis. */
export interface QuotaState {
    readonly status: PlanStatus | null;
    /** Sessions currently owed a reset, keyed by their live session identity. */
    readonly blockedAgents: ReadonlyMap<SessionId, BlockRecord>;
    readonly errorStreak: number;
}
export declare const EMPTY_STATE: QuotaState;
export interface Settlement {
    readonly state: QuotaState;
    readonly notices: readonly EdgeNotice[];
    /** Whether the account itself is currently refusing requests. */
    readonly accountBlocked: boolean;
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
export declare function settle(prev: QuotaState, next: PlanStatus, provider: string, spec: DeriveSpec): Settlement;
/** Record a session as blocked, replacing any earlier record for it. */
export declare function withBlock(state: QuotaState, sessionId: SessionId, record: BlockRecord): QuotaState;
/**
 * Drop a session's outstanding record, e.g. because it moved off this
 * provider. The failure was real, but announcing a reset for work the
 * session has since moved past is noise, and re-blocking creates a fresh
 * record anyway.
 */
export declare function withoutBlock(state: QuotaState, sessionId: SessionId): QuotaState;
