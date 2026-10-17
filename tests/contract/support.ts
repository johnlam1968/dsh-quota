/**
 * Shared machinery for the contract tier.
 *
 * Everything here is a GLOBAL seam — a stubbed `fetch`, fake timers, a real
 * `Context` — rather than an argument the row accepts. An injected clock or
 * fetch handle is a knob that can be wired wrong, and a test that passes one
 * proves the seam was passed, not that the row reads a clock at all. The row
 * must not be refactored to make these cases easier; if a case needs a new
 * handle, it wants a new observation instead.
 */
import { vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LlmFailure, UserMessage } from '@deepseek-ai/dsh-llm'

import type { QuotaConfig } from '../../src/config.js'
import type { FakeAgent } from '../harness/root.js'
import { testConfig } from '../harness/root.js'

/**
 * The row config every wake case runs under.
 *
 * Only the schedule differs from `testConfig`, and only so the arithmetic is
 * checkable by hand: one slice per wait, no jitter, no floor. With
 * `divisor: 1` the row's single wake lands exactly on the boundary the provider
 * reported, so `remains_time` IS the delay and a case can assert
 * `resetMs - 1` (silent) against `resetMs` (exactly one read). The slicing and
 * the jitter are `tests/unit/schedule.test.ts`'s job; here they would only
 * blur the boundary this tier is about.
 */
export const wakeConfig: QuotaConfig = {
  ...testConfig,
  schedule: { ...testConfig.schedule, divisor: 1, jitterRatio: 0, minIntervalMs: 1 },
}

/** One provider `model_remains[]` entry, as the endpoint reports it. */
function remains(status: number, percent: number, remainsMs: number): string {
  return JSON.stringify({
    model_remains: [{
      model_name: testConfig.entry,
      current_interval_status: status,
      current_interval_remaining_percent: percent,
      remains_time: remainsMs,
    }],
  })
}

/**
 * A body whose account window is exhausted, resetting in `remainsMs`.
 *
 * `status: 2` plus `0%` is what MiniMax reports for an exhausted interval, and
 * `remains_time` becomes the absolute `resetAt` the schedule is derived from.
 */
export const blockedBody = (remainsMs: number): string => remains(2, 0, remainsMs)

/** A body with the account window healthy, so `model` becomes usable again. */
export const healthyBody = (remainsMs: number): string => remains(1, 90, remainsMs)

export interface ScriptedEndpoint {
  /** How many HTTP attempts the row has made, retries included. */
  readonly calls: () => number
}

/**
 * Stub the global `fetch` with a queued endpoint.
 *
 * Each entry answers one HTTP ATTEMPT, not one logical read: the row retries a
 * failed read up to `readAttempts` times and every retry is its own request, so
 * an unreadable moment costs exactly that many entries. The last entry repeats,
 * so a case only has to script up to the read it cares about, and `undefined`
 * means the attempt never produced a readable body — a dropped connection,
 * which the row must survive rather than read as a reset.
 */
export function scriptEndpoint(bodies: readonly (string | undefined)[]): ScriptedEndpoint {
  let served = 0
  let calls = 0
  vi.stubGlobal('fetch', async (): Promise<unknown> => {
    calls++
    const body = served < bodies.length ? bodies[served] : bodies[bodies.length - 1]
    served++
    if (body === undefined) throw new Error('socket hang up')
    return { ok: true, status: 200, text: async () => body }
  })
  return { calls: () => calls }
}

/**
 * One unreadable logical read, spelled out.
 *
 * The row gives a read `readAttempts` attempts and only the first readable
 * verdict counts, so a read that never lands consumes that many entries. Spelt
 * this way the retry is visible in the script rather than hidden in a count.
 */
export function unreadableRead(): undefined[] {
  return Array.from({ length: testConfig.readAttempts }, () => undefined)
}

/** A session the row can resolve, plus the wakeups it received. */
export interface WakeAgent extends FakeAgent {
  /** Every message `followup` was handed, in order. */
  readonly followups: UserMessage[]
  followup(message: UserMessage): void
}

/**
 * A session stub with a recording `followup`.
 *
 * `deliver` calls `followup`, so without it the row's reset announcement would
 * be a `TypeError` and the case would prove nothing. `options.provider` is
 * optional because the `agent/error` channel carries no provider: the row can
 * only consult the agent's own route there, and "no route at all" is one of
 * the cases that must be handled.
 */
export function wakeAgent(
  id: string,
  options: { provider?: string; model?: string },
): WakeAgent {
  const followups: UserMessage[] = []
  return {
    id,
    options,
    status: 'idle',
    followups,
    followup(message: UserMessage): void {
      followups.push(message)
    },
    kill(): void {},
  }
}

/**
 * The session stub as the event payloads carry it.
 *
 * A cast, and deliberately a local one: the payloads are synthetic input this
 * case authors, not untrusted data being asserted into a shape — the harness
 * root draws the same line at its `agents.get`. The alternative, building a
 * real `Agent`, would mean constructing a session, an inbox and a driver to
 * watch a row read three fields.
 */
function asAgent(agent: WakeAgent): Agent {
  return agent as unknown as Agent
}

/** The text of an announcement, narrowed from its content block. */
export function announcementText(message: UserMessage): string {
  const block = message.content[0]
  if (block === undefined || block.type !== 'text') {
    throw new Error('the announcement carried no text block')
  }
  return block.text
}

/**
 * Emit the in-band refusal, the way the loop's post-stream settle path does.
 *
 * Returns the `next` the chain would have continued into, so a case can assert
 * the row delegated rather than swallowed it: `agent/request-error` is a
 * waterfall, and a listener that does not call `next()` makes every quota
 * refusal terminal for the step. The returned action is the loop's own default,
 * `undefined` — "leave the failure to the retry policy".
 */
export function emitRequestError(
  ctx: Context,
  agent: WakeAgent,
  failure: LlmFailure,
  provider: string = testConfig.provider,
): ReturnType<typeof vi.fn<() => Promise<undefined>>> {
  const next = vi.fn(async (): Promise<undefined> => undefined)
  ctx.emit('agent/request-error', {
    agent: asAgent(agent),
    turn: 1,
    step: 1,
    provider,
    failure,
    retryPolicy: undefined,
    signal: new AbortController().signal,
  }, next)
  return next
}

/**
 * Emit the thrown-failure channel, which carries the error verbatim and no
 * `failure` field at all — the row has to narrow `unknown` itself.
 */
export function emitAgentError(ctx: Context, agent: WakeAgent, error: unknown): void {
  ctx.emit('agent/error', { agent: asAgent(agent), turn: 1, step: 1, error })
}

/** A quota refusal as the adapter hands it over: normalised code, prose message. */
export const QUOTA_REFUSAL: LlmFailure = {
  code: 'QUOTA',
  message: '2056 usage limit exceeded',
}

/**
 * A refusal that is not an exhausted window.
 *
 * The provider-neutral code carries the meaning here, not the prose: a rate
 * limit is real and retryable, but arming a wake for one would announce a
 * reset that no window is going to deliver.
 */
export const RATE_LIMIT: LlmFailure = { code: 'RATE_LIMIT', message: '429 rate limit' }
