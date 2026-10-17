import type { PlanStatus, QuotaWindow, WindowRow } from './types.js';
/** The plan facts that decide what "usable" means for one routed model. */
export interface DeriveSpec {
    /** `model_name` carrying the account-wide rolling interval. */
    readonly entry: string;
    /**
     * Models subject to the weekly window only. Video models are exempt from
     * the 5-hour window, so a blocked 5-hour interval does not stop them.
     */
    readonly videoModelPatterns: readonly RegExp[];
    /**
     * The `model_remains[]` entry carrying video budgets, or null when the
     * provider reports none. Observed live: a `video` entry sits alongside
     * `general` with its own interval and weekly counters.
     */
    readonly videoEntry: string | null;
}
/** Whether this model is governed by the weekly window alone. */
export declare function isVideoModel(model: string, spec: DeriveSpec): boolean;
/** The windows that actually gate this model. */
export declare function windowsFor(model: string, spec: DeriveSpec): readonly QuotaWindow[];
/**
 * The row that governs `model` in `window`: the model's own row when the
 * provider reports one, otherwise the account-wide row.
 *
 * An absent row is meaningful, not an error: the provider reports weekly
 * headroom separately and it can read 100% while the 5-hour interval is
 * blocked. Callers therefore treat "no row" as "not blocked", which is the
 * only safe direction — a row we did not read can never wrongly deny a model.
 */
export declare function rowFor(rows: readonly WindowRow[], model: string, spec: DeriveSpec, window: QuotaWindow): WindowRow | undefined;
/**
 * Whether a request on `model` would be accepted right now.
 *
 * Non-video models need remaining usage in every window; video models are
 * subject to the weekly window only. The two windows reset independently, so
 * neither is allowed to speak for the other.
 */
export declare function deriveUsable(rows: readonly WindowRow[], model: string, spec: DeriveSpec): boolean;
/**
 * The rows worth showing a caller, in display order.
 *
 * One entry per gating window, resolved to whichever row actually governs
 * this model, so the prompt line and the tool never disagree with `usable`.
 */
export declare function effectiveRows(rows: readonly WindowRow[], model: string, spec: DeriveSpec): readonly WindowRow[];
/** The next instant at which any blocking row ends, or null when none will. */
export declare function nextResetAt(rows: readonly WindowRow[]): number | null;
/** Convenience wrapper for the common single-plan read. */
export declare function isUsable(status: PlanStatus | null, model: string, spec: DeriveSpec): boolean;
