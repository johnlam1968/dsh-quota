/**
 * The contract tier: what the shipped row does when real events happen to it.
 *
 * Every case here drives the row the way the runtime does — a real Cordis
 * `Context`, a real dispatch through `ctx.emit`, the real global `fetch`, real
 * fake-timer arithmetic — and then observes only what a deployment could
 * observe. Nothing calls a handler directly: a case that invoked the listener
 * would prove the listener's body, and would stay green if every registration
 * in `src/index.ts` were deleted. That gap is why this file exists, and it is
 * why the `agent/error` case and its mutation are here rather than implied.
 *
 * The two channels are tested separately because they fail differently. An
 * in-band refusal (`agent/request-error`) carries a normalised failure and the
 * provider that served it; a thrown failure (`agent/error`) carries the raw
 * value and no provider at all, so the row has to narrow `unknown` and trust
 * the agent's own route. A row that watched only the first is not obviously
 * broken — it works on every provider failure the adapter classifies — so only
 * a case on the second channel can tell.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import QuotaService from '../../src/index.js'
import type { PlanStatus } from '../../src/types.js'
import type { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { fakeAgents, makeRoot } from '../harness/root.js'
import type { AgentsSeam, FakeAgent } from '../harness/root.js'
import {
  QUOTA_REFUSAL,
  RATE_LIMIT,
  announcementText,
  blockedBody,
  emitAgentError,
  emitRequestError,
  healthyBody,
  scriptEndpoint,
  unreadableRead,
  wakeAgent,
  wakeConfig,
} from './support.js'
import type { ScriptedEndpoint } from './support.js'

/**
 * The countdown the provider reports for the exhausted window, in ms.
 *
 * `divisor: 1` and `jitterRatio: 0` (see `support.ts`) make this number the
 * row's exact delay, so the cases below can say `resetMs - 1` and `resetMs`
 * rather than "roughly a minute".
 */
const RESET_MS = 60_000

/** The row's first read happened; its timer is armed. */
const FIRST_READ = 0

/** Fibers to tear down, so no case leaves a row mounted into the next one. */
const open: Array<{ dispose(): Promise<unknown> }> = []

afterEach(async () => {
  for (const fiber of open.splice(0)) await fiber.dispose()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  delete process.env['DSH_QUOTA_TEST_KEY']
})

interface Mounted {
  /** The root every case dispatches its synthetic events on. */
  readonly root: Context
  readonly agents: AgentsSeam
  readonly endpoint: ScriptedEndpoint
  readonly fiber: { dispose(): Promise<unknown> }
}

/**
 * Mount the row against a scripted endpoint and let its first read settle.
 *
 * The read is flushed here rather than in each case so that every case starts
 * from the same fact — one readable status, one armed timer — and the
 * assertions are about what the case does next, not about how many microtasks
 * a mount takes.
 */
async function mount(bodies: readonly (string | undefined)[]): Promise<Mounted> {
  const endpoint = scriptEndpoint(bodies)
  const agents = fakeAgents()
  const root = makeRoot({ agents })
  const fiber = root.plugin(QuotaService, wakeConfig)
  await fiber
  open.push(fiber)
  await vi.advanceTimersByTimeAsync(FIRST_READ)
  return { root, agents, endpoint, fiber }
}

/** One session on the watched route, registered so the row can resolve it. */
function session(agents: AgentsSeam, id = 'session-a', model = 'minimax-M2'): FakeAgent {
  const agent = wakeAgent(id, { provider: wakeConfig.provider, model })
  agents.add(agent)
  return agent
}

/** Everything this session was woken with, in order. */
function wakes(agents: AgentsSeam, sessionId: string): readonly UserMessage[] {
  return agents.delivered
    .filter(delivery => delivery.sessionId === sessionId)
    .map(delivery => delivery.message)
}

/** The one announcement this session received; fails the case if there is not exactly one. */
function onlyWake(agents: AgentsSeam, sessionId: string): UserMessage {
  const messages = wakes(agents, sessionId)
  if (messages.length !== 1) {
    throw new Error(`expected exactly one announcement for ${sessionId}, got ${messages.length}`)
  }
  return messages[0] as UserMessage
}

describe('a session refused in band, through agent/request-error', () => {
  it('wakes it exactly when the provider window rolls, and not before', async () => {
    vi.useFakeTimers()
    process.env['DSH_QUOTA_TEST_KEY'] = 'test-key'
    const { root, agents, endpoint } = await mount([
      blockedBody(RESET_MS),
      healthyBody(3_600_000),
    ])
    const agent = session(agents)

    // One timer, armed by the row's effect — not one per read.
    expect(vi.getTimerCount()).toBe(1)
    expect(endpoint.calls()).toBe(1)
    expect(wakes(agents, agent.id)).toHaveLength(0)

    emitRequestError(root, agent, QUOTA_REFUSAL)

    // Non-actions first: nothing before the boundary the provider reported.
    // "Did not wake" alone would also pass if the row had armed nothing at
    // all, so the timer count is asserted alongside it.
    await vi.advanceTimersByTimeAsync(RESET_MS - 1)
    expect(endpoint.calls()).toBe(1)
    expect(wakes(agents, agent.id)).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(1)

    // Exactly one read at the boundary, and it is the one that resets.
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(FIRST_READ)
    expect(endpoint.calls()).toBe(2)
    expect(wakes(agents, agent.id)).toHaveLength(1)

    const message = onlyWake(agents, agent.id)
    expect(message.source.kind).toBe('quota-notice')
    const text = announcementText(message)
    // The announcement names the refusal that ended the turn, so the agent can
    // tell a reset apart from an unrelated failure later in its log...
    expect(text).toContain('QUOTA — 2056 usage limit exceeded')
    // ...and names the window from the record, captured while it was still
    // blocked. Nothing is blocked by the time this is written, so a status
    // read at wake time could not have said which window ended.
    expect(text).toContain('the 5-hour usage window has reset')
    // Still one timer: the row reschedules itself rather than stacking.
    expect(vi.getTimerCount()).toBe(1)
  })

  it('delegates the waterfall, so the refusal stays the loop\'s to retry', async () => {
    vi.useFakeTimers()
    process.env['DSH_QUOTA_TEST_KEY'] = 'test-key'
    const { root, agents } = await mount([blockedBody(RESET_MS), healthyBody(3_600_000)])
    const agent = session(agents)

    const next = emitRequestError(root, agent, QUOTA_REFUSAL)
    await vi.advanceTimersByTimeAsync(FIRST_READ)

    // `agent/request-error` is a waterfall: not calling `next()` vetoes the
    // rest of the chain and leaves the failure terminal. This row is advisory
    // — it observes and never decides — so swallowing `next` would silently
    // turn every quota refusal into a dead step.
    expect(next).toHaveBeenCalledTimes(1)

    // Delegation is not conditional on owning the recovery: the row observed
    // the refusal on the way past. Advancing to the boundary proves the record
    // survived the delegation rather than being dropped with it.
    await vi.advanceTimersByTimeAsync(RESET_MS)
    await vi.advanceTimersByTimeAsync(FIRST_READ)
    expect(wakes(agents, agent.id)).toHaveLength(1)
  })

  it('ignores a refusal the payload attributes to another route', async () => {
    vi.useFakeTimers()
    process.env['DSH_QUOTA_TEST_KEY'] = 'test-key'
    const { root, agents, endpoint } = await mount([
      blockedBody(RESET_MS),
      healthyBody(3_600_000),
    ])
    const agent = session(agents)

    // The other half of the filter, and the half a regression is easiest to
    // lose: the in-band channel DOES name the route that served the failed
    // request, so the row can — and must — judge the refusal by THAT route and
    // not by the agent's current one. Substituting `agent.options.provider`
    // here is invisible on every other case (a session on the watched route
    // agrees with itself) and would wake fallback sessions on this plan's
    // reset, which is a reset those sessions were never waiting for.
    emitRequestError(root, agent, QUOTA_REFUSAL, 'openrouter')
    await vi.advanceTimersByTimeAsync(RESET_MS)
    await vi.advanceTimersByTimeAsync(FIRST_READ)

    // The reset was read; nothing was said.
    expect(endpoint.calls()).toBe(2)
    expect(wakes(agents, agent.id)).toHaveLength(0)
  })
})

describe('a session that is gone by the time the reset lands', () => {
  it('reads the reset, tells nobody, and keeps probing', async () => {
    vi.useFakeTimers()
    process.env['DSH_QUOTA_TEST_KEY'] = 'test-key'
    const { root, agents, endpoint } = await mount([
      blockedBody(RESET_MS),
      healthyBody(3_600_000),
    ])
    const agent = session(agents)
    const published: PlanStatus[] = []
    root.on('quota/changed', ({ status }) => published.push(status))

    emitRequestError(root, agent, QUOTA_REFUSAL)
    // The session goes away while its window is still exhausted: disposed,
    // cleared, host shutdown. The row holds a record for it and will resolve a
    // notice — it must resolve the session instead, quietly.
    agent.kill()
    await vi.advanceTimersByTimeAsync(RESET_MS)
    await vi.advanceTimersByTimeAsync(FIRST_READ)

    expect(wakes(agents, agent.id)).toHaveLength(0)
    expect(endpoint.calls()).toBe(2)
    // The tick ran to the end rather than throwing at the missing session: a
    // throw here would abort the read before the row publishes it, and
    // `armTimer` would swallow it into a silent backoff to the ceiling — the
    // failure mode is invisible except as a status the row never announced.
    expect(published).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1)
  })
})

describe('a session stranded by a thrown failure, through agent/error', () => {
  it('wakes it from the raw error, which carries no failure field', async () => {
    vi.useFakeTimers()
    process.env['DSH_QUOTA_TEST_KEY'] = 'test-key'
    const { root, agents, endpoint } = await mount([
      blockedBody(RESET_MS),
      healthyBody(3_600_000),
    ])
    const agent = session(agents)

    // A dropped connection or a protocol fault never reaches the in-band
    // channel, and arrives here as the thrown value itself. The outer message
    // carries nothing a block matcher could use — only the nested, normalised
    // failure does — so a row that flattened the error would record nothing
    // and the session would never be woken.
    emitAgentError(root, agent, {
      name: 'LlmError',
      message: 'stream closed before any frame',
      failure: { code: 'QUOTA', message: '2056 usage limit exceeded' },
    })
    await vi.advanceTimersByTimeAsync(RESET_MS)
    await vi.advanceTimersByTimeAsync(FIRST_READ)

    expect(endpoint.calls()).toBe(2)
    expect(wakes(agents, agent.id)).toHaveLength(1)
    expect(announcementText(onlyWake(agents, agent.id))).toContain('QUOTA — 2056 usage limit exceeded')
  })

  it('ignores a failure from a route this plan does not watch', async () => {
    vi.useFakeTimers()
    process.env['DSH_QUOTA_TEST_KEY'] = 'test-key'
    const { root, agents, endpoint } = await mount([
      blockedBody(RESET_MS),
      healthyBody(3_600_000),
    ])
    // No payload field names the provider here, so the row can only consult
    // the agent's own route. This session is on a fallback: this plan's reset
    // is not what unblocked it, and announcing one would be a reset that never
    // comes.
    const elsewhere = wakeAgent('session-b', { provider: 'openrouter', model: 'other/model' })
    agents.add(elsewhere)

    emitAgentError(root, elsewhere, { failure: { code: 'QUOTA', message: 'usage limit exceeded' } })
    await vi.advanceTimersByTimeAsync(RESET_MS)
    await vi.advanceTimersByTimeAsync(FIRST_READ)

    // The reset was still read — the row is awake and did its work.
    expect(endpoint.calls()).toBe(2)
    // ...and it said nothing to a session this plan never blocked.
    expect(wakes(agents, elsewhere.id)).toHaveLength(0)
  })

  it('records the failure when the agent states no route at all', async () => {
    vi.useFakeTimers()
    process.env['DSH_QUOTA_TEST_KEY'] = 'test-key'
    const { root, agents } = await mount([blockedBody(RESET_MS), healthyBody(3_600_000)])
    // The mirror of the previous case. An absent route is not evidence of a
    // foreign one: filtering on `!== undefined` rather than on equality keeps
    // the row from dropping a real refusal just because the agent has not
    // resolved its route yet — the conservative direction, since the cost is a
    // possible extra announcement and the alternative is a silent session.
    const unrouted = wakeAgent('session-c', { model: 'minimax-M2' })
    agents.add(unrouted)

    emitAgentError(root, unrouted, { failure: { code: 'QUOTA', message: 'usage limit exceeded' } })
    await vi.advanceTimersByTimeAsync(RESET_MS)
    await vi.advanceTimersByTimeAsync(FIRST_READ)

    expect(wakes(agents, unrouted.id)).toHaveLength(1)
  })

  it('ignores a failure that is not an exhausted window', async () => {
    vi.useFakeTimers()
    process.env['DSH_QUOTA_TEST_KEY'] = 'test-key'
    const { root, agents, endpoint } = await mount([
      blockedBody(RESET_MS),
      healthyBody(3_600_000),
    ])
    const agent = session(agents)

    // A rate limit is a real failure and a retryable one, but no window is
    // going to reset. Arming a wake for it would promise a reset that never
    // arrives, which is worse than saying nothing.
    emitAgentError(root, agent, RATE_LIMIT)
    await vi.advanceTimersByTimeAsync(RESET_MS)
    await vi.advanceTimersByTimeAsync(FIRST_READ)

    expect(endpoint.calls()).toBe(2)
    expect(wakes(agents, agent.id)).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('keeps the session owed across a read that never lands', async () => {
    vi.useFakeTimers()
    process.env['DSH_QUOTA_TEST_KEY'] = 'test-key'
    // The window rolls while the endpoint is unreadable. A failed read says
    // nothing about any window, so the row must keep the last GOOD status and
    // the outstanding block rather than treating the drop as a reset — or as a
    // reason to forget the session.
    const { root, agents, endpoint } = await mount([
      blockedBody(RESET_MS),
      ...unreadableRead(),
      healthyBody(3_600_000),
    ])
    const agent = session(agents)

    emitAgentError(root, agent, QUOTA_REFUSAL)
    await vi.advanceTimersByTimeAsync(RESET_MS)
    await vi.advanceTimersByTimeAsync(FIRST_READ)

    // The read at the boundary was retried and never became readable; that
    // cost one attempt per configured try, and announced nothing.
    expect(endpoint.calls()).toBe(1 + wakeConfig.readAttempts)
    expect(wakes(agents, agent.id)).toHaveLength(0)

    // HOW LONG it waits is the schedule's business, and this case must not
    // encode that shape — the backoff is covered by `schedule.test.ts`, and a
    // contract case that fails because the multiplier changed would be a
    // false alarm about the wiring. What matters is that it comes back on its
    // own within the ceiling it configured for itself...
    await vi.advanceTimersByTimeAsync(wakeConfig.schedule.maxBackoffMs)
    await vi.advanceTimersByTimeAsync(FIRST_READ)
    expect(endpoint.calls()).toBe(2 + wakeConfig.readAttempts)
    // ...and that the very next readable status still finds the session owed.
    expect(wakes(agents, agent.id)).toHaveLength(1)
    expect(announcementText(onlyWake(agents, agent.id))).toContain('has reset')
  })
})

describe('the row\'s timer is owned, not leaked', () => {
  it('holds exactly one timer across wakes and none after dispose', async () => {
    vi.useFakeTimers()
    process.env['DSH_QUOTA_TEST_KEY'] = 'test-key'
    const cadence = wakeConfig.schedule.maxIntervalMs
    const { fiber, endpoint } = await mount([healthyBody(3_600_000)])

    // A healthy plan is probed at the slow cadence. Two wakes must still leave
    // one timer: a row that armed per tick would accumulate them, and in
    // deployment would hammer the endpoint in proportion to how long it ran.
    await vi.advanceTimersByTimeAsync(cadence)
    await vi.advanceTimersByTimeAsync(FIRST_READ)
    expect(endpoint.calls()).toBe(2)
    await vi.advanceTimersByTimeAsync(cadence)
    await vi.advanceTimersByTimeAsync(FIRST_READ)
    expect(endpoint.calls()).toBe(3)
    expect(vi.getTimerCount()).toBe(1)

    // The ownership half: the timer belongs to an effect, so disposing the row
    // clears it. `getTimerCount()` rather than a fetch count, because "did not
    // probe again" is also true of a row that stopped probing forever.
    await fiber.dispose()
    await vi.advanceTimersByTimeAsync(FIRST_READ)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(cadence * 2)
    expect(endpoint.calls()).toBe(3)
  })
})
