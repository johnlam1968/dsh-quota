import z from '@deepseek-ai/schemastery'
import type { ScheduleConfig } from './schedule.js'
import type { ProbeSpec } from './probe.js'

/**
 * Every field here is a provider fact or an operator preference that a
 * deployment must be able to change in `cordis.yml` without editing code.
 * A field that only ever held one value would be a bug.
 */
export const Config = z.object({
  /** Provider route id this row watches. Matched against `LlmCallConfig.provider`. */
  provider: z.string(),

  /** `model_name` carrying the account-wide rolling interval. */
  entry: z.string().default('general'),

  /** Quota endpoint. The bearer token is read from `authEnv`, never inlined. */
  endpoint: z.string(),

  /** Name of the environment variable holding the bearer token. */
  authEnv: z.string(),

  /** Per-request timeout for the quota read, in ms. */
  requestTimeoutMs: z.natural().min(1).default(15_000),

  /**
   * How many attempts one read gets. A dropped call must never be the thing
   * that decides the state, so the first readable verdict wins.
   */
  readAttempts: z.natural().min(1).default(3),

  /** Models exempt from the 5-hour window, i.e. subject to the weekly one only. */
  videoModelPatterns: z.array(z.string()).default([]),

  /**
   * Regex sources recognising the provider's usage-limit refusal. Provider
   * wording drifts, and a specific vendor's code arrives inside `message`
   * rather than in the provider-neutral `code` field, so these match across
   * all three failure fields.
   */
  blockPatterns: z.array(z.string()).default(['usage limit exceeded', '\\b2056\\b']),

  /** Below this remaining percent, a healthy plan is worth mentioning. */
  lowWaterMarkPercent: z.number().min(0).max(100).default(20),

  schedule: z.object({
    /** How many equal slices to divide the remaining wait into. */
    divisor: z.natural().min(1).default(4),
    /** Floor for a probing interval, in ms. Stops a spin loop near a boundary. */
    minIntervalMs: z.natural().min(1).default(15_000),
    /** Ceiling for a probing interval, in ms. Bounds how long a new block goes unseen. */
    maxIntervalMs: z.natural().min(1).default(900_000),
    /** How long past a reported boundary to wait before confirming. */
    skewMs: z.natural().min(0).default(30_000),
    /** First backoff step after a failed read, in ms. */
    baseBackoffMs: z.natural().min(1).default(1_000),
    /** Backoff ceiling after repeated failures, in ms. */
    maxBackoffMs: z.natural().min(1).default(300_000),
    /** Fractional spread on every delay, so two hosts do not sync up. */
    jitterRatio: z.number().min(0).max(0.5).default(0.1),
  }).default({}),

  /** Where the blocked-window marker is written. Empty disables persistence. */
  markerPath: z.string().default(''),
})

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
  provider: string
  entry: string
  endpoint: string
  authEnv: string
  requestTimeoutMs: number
  readAttempts: number
  videoModelPatterns: string[]
  blockPatterns: string[]
  lowWaterMarkPercent: number
  schedule: {
    divisor: number
    minIntervalMs: number
    maxIntervalMs: number
    skewMs: number
    baseBackoffMs: number
    maxBackoffMs: number
    jitterRatio: number
  }
  markerPath: string
}

/** Compiled from config once, at construction. */
export interface PlanDefinition {
  readonly probe: ProbeSpec
  readonly derive: {
    readonly entry: string
    readonly videoModelPatterns: readonly RegExp[]
  }
  readonly blockPatterns: readonly RegExp[]
  readonly schedule: ScheduleConfig
}

/**
 * Compile the string patterns into RegExp objects, failing loudly.
 *
 * A bad pattern that silently compiled to something that never matches would
 * leave the deployment without block detection and without any symptom, so
 * this throws at load and the fiber goes FAILED.
 */
export function definePlan(config: QuotaConfig): PlanDefinition {
  const compile = (sources: readonly string[], flags: string): RegExp[] =>
    sources.map(source => {
      try {
        return new RegExp(source, flags)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(`dsh-quota: invalid pattern ${JSON.stringify(source)}: ${reason}`)
      }
    })

  // Validated here rather than in the schema: schemastery's string schema has
  // no URL node, and a bad endpoint should fail the load loudly, not on the
  // first probe minutes later.
  try {
    new URL(config.endpoint)
  } catch {
    throw new Error(`dsh-quota: endpoint is not a URL: ${JSON.stringify(config.endpoint)}`)
  }

  return {
    probe: { provider: config.provider, entry: config.entry },
    derive: {
      entry: config.entry,
      videoModelPatterns: compile(config.videoModelPatterns, 'i'),
    },
    blockPatterns: compile(config.blockPatterns, 'i'),
    schedule: {
      divisor: config.schedule.divisor,
      minIntervalMs: config.schedule.minIntervalMs,
      maxIntervalMs: config.schedule.maxIntervalMs,
      skewMs: config.schedule.skewMs,
      baseBackoffMs: config.schedule.baseBackoffMs,
      maxBackoffMs: config.schedule.maxBackoffMs,
      jitterRatio: config.schedule.jitterRatio,
    },
  }
}
