import type { PlanStatus, QuotaWindow } from './types.js';
import type { DeriveSpec } from './derive.js';
/** Everything the announcement needs, with nothing it does not. */
export interface NoticeFacts {
    readonly provider: string;
    /**
     * Which window was the one that recovered.
     *
     * This is the ONLY fact about the outage that survives. At wake time every
     * row reads healthy, so nothing in the current status can say which window
     * expired; the edge that produced this message is what carries it.
     */
    readonly window: QuotaWindow;
    readonly status: PlanStatus;
    readonly model: string;
    readonly spec: DeriveSpec;
}
/**
 * The noun phrase naming what reset.
 *
 * Built from the edge's window rather than the current status: at wake time
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
 * it has two jobs and no third: say the window is usable again, and make
 * resuming the obvious next action.
 *
 * It deliberately does NOT claim the session's last turn was refused, name a
 * provider error code, or quote how long the window was exhausted. The row
 * detects the outage by PROBING, so it never saw any refusal — an earlier
 * version synthesised all three and told the agent something untrue. The
 * observation and the guess must not be confused; if a per-session record is
 * ever wanted, it has to come from an observed error, not from a probe.
 */
export declare function noticeText(facts: NoticeFacts): string;
