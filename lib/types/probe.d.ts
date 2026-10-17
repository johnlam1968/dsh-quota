import type { PlanStatus } from './types.js';
/** What the probe needs to know about the plan it is reading. */
export interface ProbeSpec {
    readonly provider: string;
    /** The `model_name` carrying the account-wide rolling interval. */
    readonly entry: string;
}
/**
 * Narrow one provider response into detached rows.
 *
 * Never throws and never partially succeeds: every failure path returns a
 * status whose only populated field is `error`. The endpoint is untrusted
 * input, so every field is narrowed by an explicit check and nothing is cast.
 *
 * `model_remains` holds one entry per account group — `general` and `video`
 * were both observed — and every entry carries BOTH windows as parallel field
 * families. See `docs/.superpowers/live-response-shape.md` for the measured
 * shape; it replaces an earlier guess that the weekly window lived elsewhere.
 *
 * The two windows block on DIFFERENT evidence, which is not a stylistic choice.
 * Measured: `current_interval_status` reads 1 when healthy and 2 when
 * exhausted, but `current_weekly_status` was observed sitting on **3** while
 * `current_weekly_remaining_percent` read **100**. The weekly vocabulary is
 * therefore not shared with the interval's and cannot be mapped without
 * actually hitting the wall, so the weekly row blocks on percentage alone and
 * keeps status for diagnostics only. Blocking on an unmapped status would halt
 * every session for no reason; the asymmetry is the safe direction.
 */
export declare function classifyQuota(body: string, now: number, spec: ProbeSpec): PlanStatus;
