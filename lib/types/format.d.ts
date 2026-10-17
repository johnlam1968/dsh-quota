import type { PlanStatus, QuotaWindow } from './types.js';
import type { DeriveSpec } from './derive.js';
/** How a countdown is spoken. Deterministic: no clock, no locale. */
export declare function formatDuration(ms: number): string;
/** The window name as a reader sees it. */
export declare function windowLabel(window: QuotaWindow): string;
/**
 * One line of quota state for the system prompt, or '' when there is nothing
 * worth spending prompt tokens on.
 *
 * Silent in three cases, deliberately: never read yet, a read that failed, and
 * healthy-and-comfortable. An agent spends attention on this line, so it must
 * not become wallpaper — it appears when the model is blocked or when the
 * remaining budget is low enough to be worth pacing around.
 *
 * `usable` is computed by the same `derive` the tool and the wake edge use, so
 * the prompt can never contradict them.
 */
export declare function renderQuotaStatus(status: PlanStatus | null, model: string, spec: DeriveSpec, lowWaterMarkPercent: number): string;
