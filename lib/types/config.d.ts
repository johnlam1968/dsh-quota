import z from '@deepseek-ai/schemastery';
import type { ScheduleConfig } from './schedule.js';
import type { ProbeSpec } from './probe.js';
/**
 * Every field here is a provider fact or an operator preference that a
 * deployment must be able to change in `cordis.yml` without editing code.
 * A field that only ever held one value would be a bug.
 */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    /** Provider route id this row watches. Matched against `LlmCallConfig.provider`. */
    provider: z<string, string, "plain">;
    /** `model_name` carrying the account-wide rolling interval. */
    entry: z<string, string, "defined">;
    /** Quota endpoint. The bearer token is read from `authEnv`, never inlined. */
    endpoint: z<string, string, "plain">;
    /** Name of the environment variable holding the bearer token. */
    authEnv: z<string, string, "plain">;
    /** Per-request timeout for the quota read, in ms. */
    requestTimeoutMs: z<number, number, "defined">;
    /**
     * How many attempts one read gets. A dropped call must never be the thing
     * that decides the state, so the first readable verdict wins.
     */
    readAttempts: z<number, number, "defined">;
    /** Models exempt from the 5-hour window, i.e. subject to the weekly one only. */
    videoModelPatterns: z<string[], string[], "defined">;
    /**
     * The `model_remains[]` entry holding video budgets. Observed live alongside
     * `general`. Empty disables video-entry routing, leaving video models on the
     * account-wide row.
     */
    videoEntry: z<string, string, "defined">;
    /**
     * Regex sources recognising a usage-limit refusal the adapter did NOT
     * already classify.
     *
     * The adapter normalises provider wording into `QUOTA` /
     * `ACCOUNT_QUOTA` before the failure reaches this row, and those codes are
     * matched exactly in code — see `HARNESS_QUOTA_CODES`. These patterns are
     * only the net for providers or builds that classify nothing, so they
     * carry provider prose rather than a normalised code.
     */
    blockPatterns: z<string[], string[], "defined">;
    /** Below this remaining percent, a healthy plan is worth mentioning. */
    lowWaterMarkPercent: z<number, number, "defined">;
    schedule: z<Schemastery.ObjectS<NoInfer<{
        /** How many equal slices to divide the remaining wait into. */
        divisor: z<number, number, "defined">;
        /** Floor for a probing interval, in ms. Stops a spin loop near a boundary. */
        minIntervalMs: z<number, number, "defined">;
        /** Ceiling for a probing interval, in ms. Bounds how long a new block goes unseen. */
        maxIntervalMs: z<number, number, "defined">;
        /** How long past a reported boundary to wait before confirming. */
        skewMs: z<number, number, "defined">;
        /** First backoff step after a failed read, in ms. */
        baseBackoffMs: z<number, number, "defined">;
        /** Backoff ceiling after repeated failures, in ms. */
        maxBackoffMs: z<number, number, "defined">;
        /** Fractional spread on every delay, so two hosts do not sync up. */
        jitterRatio: z<number, number, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        /** How many equal slices to divide the remaining wait into. */
        divisor: z<number, number, "defined">;
        /** Floor for a probing interval, in ms. Stops a spin loop near a boundary. */
        minIntervalMs: z<number, number, "defined">;
        /** Ceiling for a probing interval, in ms. Bounds how long a new block goes unseen. */
        maxIntervalMs: z<number, number, "defined">;
        /** How long past a reported boundary to wait before confirming. */
        skewMs: z<number, number, "defined">;
        /** First backoff step after a failed read, in ms. */
        baseBackoffMs: z<number, number, "defined">;
        /** Backoff ceiling after repeated failures, in ms. */
        maxBackoffMs: z<number, number, "defined">;
        /** Fractional spread on every delay, so two hosts do not sync up. */
        jitterRatio: z<number, number, "defined">;
    }>>, "defined">;
    /** Where the blocked-window marker is written. Empty disables persistence. */
    markerPath: z<string, string, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    /** Provider route id this row watches. Matched against `LlmCallConfig.provider`. */
    provider: z<string, string, "plain">;
    /** `model_name` carrying the account-wide rolling interval. */
    entry: z<string, string, "defined">;
    /** Quota endpoint. The bearer token is read from `authEnv`, never inlined. */
    endpoint: z<string, string, "plain">;
    /** Name of the environment variable holding the bearer token. */
    authEnv: z<string, string, "plain">;
    /** Per-request timeout for the quota read, in ms. */
    requestTimeoutMs: z<number, number, "defined">;
    /**
     * How many attempts one read gets. A dropped call must never be the thing
     * that decides the state, so the first readable verdict wins.
     */
    readAttempts: z<number, number, "defined">;
    /** Models exempt from the 5-hour window, i.e. subject to the weekly one only. */
    videoModelPatterns: z<string[], string[], "defined">;
    /**
     * The `model_remains[]` entry holding video budgets. Observed live alongside
     * `general`. Empty disables video-entry routing, leaving video models on the
     * account-wide row.
     */
    videoEntry: z<string, string, "defined">;
    /**
     * Regex sources recognising a usage-limit refusal the adapter did NOT
     * already classify.
     *
     * The adapter normalises provider wording into `QUOTA` /
     * `ACCOUNT_QUOTA` before the failure reaches this row, and those codes are
     * matched exactly in code — see `HARNESS_QUOTA_CODES`. These patterns are
     * only the net for providers or builds that classify nothing, so they
     * carry provider prose rather than a normalised code.
     */
    blockPatterns: z<string[], string[], "defined">;
    /** Below this remaining percent, a healthy plan is worth mentioning. */
    lowWaterMarkPercent: z<number, number, "defined">;
    schedule: z<Schemastery.ObjectS<NoInfer<{
        /** How many equal slices to divide the remaining wait into. */
        divisor: z<number, number, "defined">;
        /** Floor for a probing interval, in ms. Stops a spin loop near a boundary. */
        minIntervalMs: z<number, number, "defined">;
        /** Ceiling for a probing interval, in ms. Bounds how long a new block goes unseen. */
        maxIntervalMs: z<number, number, "defined">;
        /** How long past a reported boundary to wait before confirming. */
        skewMs: z<number, number, "defined">;
        /** First backoff step after a failed read, in ms. */
        baseBackoffMs: z<number, number, "defined">;
        /** Backoff ceiling after repeated failures, in ms. */
        maxBackoffMs: z<number, number, "defined">;
        /** Fractional spread on every delay, so two hosts do not sync up. */
        jitterRatio: z<number, number, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        /** How many equal slices to divide the remaining wait into. */
        divisor: z<number, number, "defined">;
        /** Floor for a probing interval, in ms. Stops a spin loop near a boundary. */
        minIntervalMs: z<number, number, "defined">;
        /** Ceiling for a probing interval, in ms. Bounds how long a new block goes unseen. */
        maxIntervalMs: z<number, number, "defined">;
        /** How long past a reported boundary to wait before confirming. */
        skewMs: z<number, number, "defined">;
        /** First backoff step after a failed read, in ms. */
        baseBackoffMs: z<number, number, "defined">;
        /** Backoff ceiling after repeated failures, in ms. */
        maxBackoffMs: z<number, number, "defined">;
        /** Fractional spread on every delay, so two hosts do not sync up. */
        jitterRatio: z<number, number, "defined">;
    }>>, "defined">;
    /** Where the blocked-window marker is written. Empty disables persistence. */
    markerPath: z<string, string, "defined">;
}>>, "plain">;
/**
 * The validated shape of `Config`.
 *
 * Written out rather than inferred from the schema on purpose: schemastery's
 * `ObjectT` intersects with `Dict`, which poisons every downstream `Partial<>`
 * and gives error messages about `constructor`. The cost is that this and the
 * schema above must be kept in step by hand — `definePlan` reads every field
 * below, and the defaults test asserts each one is present after a resolve, so
 * a field added to one and not the other fails a test rather than reading as
 * `undefined` at runtime.
 */
export interface QuotaConfig {
    provider: string;
    entry: string;
    endpoint: string;
    authEnv: string;
    requestTimeoutMs: number;
    readAttempts: number;
    videoModelPatterns: string[];
    videoEntry: string;
    blockPatterns: string[];
    lowWaterMarkPercent: number;
    schedule: {
        divisor: number;
        minIntervalMs: number;
        maxIntervalMs: number;
        skewMs: number;
        baseBackoffMs: number;
        maxBackoffMs: number;
        jitterRatio: number;
    };
    markerPath: string;
}
/** Compiled from config once, at construction. */
export interface PlanDefinition {
    readonly probe: ProbeSpec;
    readonly derive: {
        readonly entry: string;
        readonly videoModelPatterns: readonly RegExp[];
        readonly videoEntry: string | null;
    };
    readonly blockPatterns: readonly RegExp[];
    readonly schedule: ScheduleConfig;
}
/**
 * Compile the string patterns into RegExp objects, failing loudly.
 *
 * A bad pattern that silently compiled to something that never matches would
 * leave the deployment without block detection and without any symptom, so
 * this throws at load and the fiber goes FAILED.
 */
export declare function definePlan(config: QuotaConfig): PlanDefinition;
