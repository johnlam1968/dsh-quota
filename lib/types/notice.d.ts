import type { BlockRecord, PlanStatus } from './types.js';
import type { DeriveSpec } from './derive.js';
/** Everything the announcement needs, with nothing it does not. */
export interface NoticeFacts {
    readonly provider: string;
    readonly record: BlockRecord;
    readonly status: PlanStatus;
    readonly model: string;
    readonly spec: DeriveSpec;
}
/**
 * The noun phrase naming what reset.
 *
 * Built from the record's window rather than the current status: at wake time
 * every row reads healthy, so a snapshot cannot tell us which window expired.
 */
export declare function blockedPhrase(facts: NoticeFacts): string;
/**
 * The one-line account carried in the message source.
 *
 * Rendered collapsed in the client, so it states what happened and nothing
 * else. It is written to fit well inside `CONTEXT_SUMMARY_MAX_CHARS` on its
 * own rather than relying on being truncated.
 */
export declare function noticeSummary(facts: NoticeFacts): string;
/**
 * The announcement text.
 *
 * This message exists to wake an agent whose turn died on a quota refusal, so
 * it has three jobs and no fourth: say that the limit is gone, say what it
 * was, and make resuming the obvious next action. It must not scold, must not
 * apologise, and must not pretend to know what the interrupted work was — the
 * session log knows that, and the agent does too.
 */
export declare function noticeText(facts: NoticeFacts): string;
