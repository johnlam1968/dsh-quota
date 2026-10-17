import type { PlanStatus } from './types.js';
/** Probing budget. Every field is deployment configuration, never a constant. */
export interface ScheduleConfig {
    /** How many slices to divide the remaining wait into. */
    readonly divisor: number;
    /** Floor for a probing interval, in ms. */
    readonly minIntervalMs: number;
    /** Ceiling for a probing interval, in ms; also the healthy-state cadence. */
    readonly maxIntervalMs: number;
    /** How long past the reported boundary to wait before confirming. */
    readonly skewMs: number;
    /** First backoff step after a failed read, in ms. */
    readonly baseBackoffMs: number;
    /** Backoff ceiling after repeated failures, in ms. */
    readonly maxBackoffMs: number;
    /** Fractional spread applied to every delay, so hosts do not sync up. */
    readonly jitterRatio: number;
}
export type ScheduleReason = 'read-failed' | 'usable' | 'blocked-no-countdown' | 'boundary-now' | 'counting-down';
export interface Schedule {
    readonly delayMs: number;
    readonly reason: ScheduleReason;
}
/**
 * Spread a delay by `ratio`, deterministically from `salt`.
 *
 * `salt` is required rather than random so the schedule is a pure function of
 * its inputs: the service passes `Math.random()`, tests pass 0.5 for the
 * identity. Two hosts sharing one provider account converge on the same
 * instants without this, and hammer the endpoint at exactly the boundary.
 */
export declare function jittered(delayMs: number, ratio: number, salt: number): number;
/**
 * Decide when to probe again.
 *
 * The provider reports the countdown to the window boundary, so the reset time
 * is known rather than searched for. The remaining wait is divided into
 * `divisor` equal slices so the last one lands on the boundary, and the slice
 * is then clamped into `[minIntervalMs, maxIntervalMs]`.
 *
 * The two bounds do different jobs. The floor stops a near boundary from
 * becoming a spin loop. The ceiling bounds how long a NEW block can go
 * unnoticed — without it, a seven-day weekly wait would divide into a slice
 * longer than any useful detection interval. The ceiling is what makes the
 * cost of a long wait linear in the healthy cadence: a four-hour wait costs
 * sixteen probes, not the nine hundred and sixty a fixed `minIntervalMs`
 * would spend.
 *
 * `usable` is passed in rather than computed here: whether a plan is usable
 * depends on the routed model, and this function stays model-agnostic.
 * `errorStreak` is likewise caller-owned because it is state across probes.
 */
export declare function nextDelay(status: PlanStatus, usable: boolean, now: number, cfg: ScheduleConfig, errorStreak: number, salt: number): Schedule;
