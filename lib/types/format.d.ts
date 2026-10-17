import type { PlanStatus, QuotaWindow } from './types.js';
import type { DeriveSpec } from './derive.js';
/** How a countdown is spoken. Deterministic: no clock, no locale. */
export declare function formatDuration(ms: number): string;
/** The window name as a reader sees it. */
export declare function windowLabel(window: QuotaWindow): string;
/**
 * One line of quota state for the system prompt, or '' when there is nothing
 * to report.
 *
 * **Always on whenever we have a reading.** A session starts with no memory of
 * the account, so its status has to be in context from the first turn — not
 * only once the budget is nearly gone. An agent that learns about the ceiling
 * when it hits it is an agent that already wasted the window.
 *
 * Silent in exactly two cases: never read yet, and a read that failed. Both are
 * silence rather than a guess, because saying "exhausted" after a failed HTTP
 * request would halt an agent over nothing.
 *
 * What is graded is the WORDING, not the presence: blocked says so plainly, a
 * low window says to pace, a comfortable one just states the numbers.
 *
 * `usable` is computed by the same `derive` the tool and the wake edge use, so
 * the prompt can never contradict them.
 */
export declare function renderQuotaStatus(status: PlanStatus | null, model: string, spec: DeriveSpec, lowWaterMarkPercent: number): string;
