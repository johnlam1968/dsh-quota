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
 * Only the rolling 5-hour interval is read. The provider reports weekly
 * headroom separately and it can read 100% while the interval is blocked, so
 * inferring a block from it would be wrong in both directions. Until the
 * weekly field path is confirmed against a live response, `derive.ts` treats
 * an absent weekly row as "not blocked" — the conservative direction, since
 * only a confirmed row ever blocks.
 */
export declare function classifyQuota(body: string, now: number, spec: ProbeSpec): PlanStatus;
