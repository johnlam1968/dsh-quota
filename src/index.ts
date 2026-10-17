import { rmSync, writeFileSync } from 'node:fs'

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'

import { Config, definePlan } from './config.js'
import type { PlanDefinition, QuotaConfig } from './config.js'
import { classifyQuota } from './probe.js'
import { isUsable, windowsFor } from './derive.js'
import type { DeriveSpec } from './derive.js'
import { nextDelay } from './schedule.js'
import type { Schedule } from './schedule.js'
import { matchesBlock } from './block.js'
import type { FailureLike } from './block.js'
import { noticeSummary, noticeText } from './notice.js'
import { createQuotaNotice } from './message.js'
import { EMPTY_STATE, settle, withBlock, withoutBlock } from './state.js'
import type { EdgeNotice, QuotaState } from './state.js'
import type { BlockRecord, PlanStatus, QuotaWindow } from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Emitted after every probe that produced a readable status. */
    'quota/changed'(payload: { status: PlanStatus }): void
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    quota: QuotaService
  }
}

/**
 * Narrow the `unknown` on `agent/error` to the fields block matching reads.
 *
 * That channel carries the raw thrown value, never an `LlmFailure`, so every
 * field is checked explicitly and nothing is asserted. A thrown
 * `LlmError` keeps its own `failure`; anything else is flattened to its
 * message with an unknown code, which will not match a quota pattern — the
 * conservative outcome.
 */
function narrowFailure(error: unknown): FailureLike {
  if (typeof error !== 'object' || error === null) {
    return { code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) }
  }
  const failure = (error as { failure?: unknown }).failure
  if (typeof failure === 'object' && failure !== null) {
    const f = failure as Record<string, unknown>
    if (typeof f['code'] === 'string' && typeof f['message'] === 'string') {
      const status = typeof f['status'] === 'number' ? f['status'] : undefined
      return { code: f['code'], message: f['message'], ...(status === undefined ? {} : { status }) }
    }
  }
  const message = (error as { message?: unknown }).message
  return {
    code: typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'UNKNOWN',
    message: typeof message === 'string' ? message : String(error),
  }
}

/** Read the environment without letting an absent key read as an empty token. */
function bearer(envName: string): string | undefined {
  const value = process.env[envName]
  return value === undefined || value.length === 0 ? undefined : value
}

/**
 * Watches one provider's rolling usage windows and wakes sessions that were
 * halted by an exhausted one.
 *
 * It is advisory. It never blocks, queues, denies or rewrites a request: it
 * observes, it renders a line of context, and at most it ADDS one user-role
 * message after a reset. A session that ignores it entirely is unaffected.
 */
export default class QuotaService extends Service {
  static inject = ['agents']
  static Config = Config

  private readonly config: QuotaConfig
  private readonly plan: PlanDefinition
  private state: QuotaState = EMPTY_STATE
  private accountBlocked = false

  constructor(ctx: Context, config: QuotaConfig) {
    super(ctx, 'quota')
    this.config = config
    this.plan = definePlan(config)

    // Two channels, because one is not enough.
    //
    // `agent/request-error` fires only when the stream ends with
    // finish.kind === 'error' | 'aborted' — an IN-BAND refusal, and the only
    // channel that carries a structured `failure` and the provider.
    //
    // A THROWN transport or protocol failure never reaches it. In the
    // installed loop the waterfall sits inside the post-stream settle path,
    // guarded by exactly that finish check; a throw jumps past it, is
    // recorded as turn/end {kind:'error'}, and surfaces only as `agent/error`,
    // whose payload has no `failure` at all. A session stranded by a dropped
    // connection is precisely the case this row exists for, so both are
    // observed.
    this.ctx.on('agent/request-error', async (payload, next) => {
      this.recordBlock(payload.agent.id, payload.failure, payload.provider)
      return await next()
    })

    this.ctx.on('agent/error', ({ agent, error }) => {
      const failure = narrowFailure(error)
      // No provider on this channel, so only the current route can be
      // checked. A session on another route cannot have been blocked by this
      // plan's quota in the first place.
      this.recordBlock(agent.id, failure, agent.options.provider)
    })

    this.ctx.effect(() => this.armTimer())
  }

  /** The current detached status, or null before the first read. */
  status(): PlanStatus | null {
    return this.state.status
  }

  /** Read now instead of waiting for the timer, and settle the result. */
  async refresh(): Promise<PlanStatus> {
    await this.tick()
    return this.state.status ?? this.errorStatus('no status available')
  }

  private get deriveSpec(): DeriveSpec {
    return this.plan.derive
  }

  private errorStatus(error: string): PlanStatus {
    return { provider: this.config.provider, checkedAt: Date.now(), rows: [], error }
  }

  /** One HTTP attempt. Never throws; every failure becomes a readable error. */
  private async readOnce(now: number): Promise<PlanStatus> {
    const token = bearer(this.config.authEnv)
    if (token === undefined) {
      return this.errorStatus(`environment variable ${this.config.authEnv} is unset`)
    }
    try {
      const response = await fetch(this.config.endpoint, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      })
      if (!response.ok) {
        return this.errorStatus(`endpoint returned HTTP ${response.status}`)
      }
      return classifyQuota(await response.text(), now, this.plan.probe)
    } catch (error) {
      return this.errorStatus(error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * One logical read.
   *
   * A single call is not one fact. The first readable verdict wins, because
   * a dropped request must never be the thing that decides the state.
   */
  private async read(now: number): Promise<PlanStatus> {
    let last = this.errorStatus('no attempt was made')
    for (let attempt = 0; attempt < this.config.readAttempts; attempt++) {
      last = await this.readOnce(now)
      if (last.error === null) return last
    }
    return last
  }

  /**
   * Fold one probe in, deliver whatever it unblocked, and return when to probe
   * again.
   *
   * The schedule is driven by the ACCOUNT view — the entry row standing in
   * for a model — because the timer serves every subscriber at once. If it
   * followed any single subscriber's model, a session on a video model (exempt
   * from the 5-hour window) could keep the whole row asleep through a text
   * model's reset.
   */
  private async tick(): Promise<Schedule> {
    const now = Date.now()
    const next = await this.read(now)
    const settled = settle(this.state, next, this.config.provider, this.plan.derive)
    this.state = settled.state

    if (settled.accountBlocked !== this.accountBlocked) {
      this.accountBlocked = settled.accountBlocked
      this.persistMarker()
    }

    for (const notice of settled.notices) this.deliver(notice)

    if (next.error === null) this.ctx.emit('quota/changed', { status: next })

    return nextDelay(
      next,
      isUsable(next, this.plan.probe.entry, this.plan.derive),
      now,
      this.plan.schedule,
      this.state.errorStreak,
      Math.random(),
    )
  }

  /** One self-rescheduling timer, owned by a single effect. */
  private armTimer(): () => void {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const arm = (delayMs: number): void => {
      if (stopped) return
      timer = setTimeout(() => {
        void this.tick().then(
          schedule => arm(schedule.delayMs),
          () => arm(this.plan.schedule.maxIntervalMs),
        )
      }, delayMs)
      timer.unref?.()
    }

    // Read once immediately: the first status should not wait out a delay.
    void this.tick().then(
      schedule => arm(schedule.delayMs),
      () => arm(this.plan.schedule.maxIntervalMs),
    )

    return () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * Remember that a session was refused, so its reset can wake it.
   *
   * `provider` is the route that served the failed request. A failure from a
   * route this row does not watch is not ours to record — a blocked session
   * on a fallback provider must not be woken by this plan's reset.
   */
  private recordBlock(
    sessionId: SessionId,
    failure: FailureLike,
    provider: string | undefined,
  ): void {
    if (provider !== undefined && provider !== this.config.provider) return
    if (!matchesBlock(failure, this.plan.blockPatterns)) return
    const agent = this.ctx.agents.get(sessionId)
    const model = agent?.options.model ?? ''
    const record: BlockRecord = {
      window: this.windowFor(model),
      model,
      since: Date.now(),
      code: failure.code,
      message: failure.message,
    }
    this.state = withBlock(this.state, sessionId, record)
  }

  /** Which window will gate this model right now. */
  private windowFor(model: string): QuotaWindow {
    const status = this.state.status
    if (status === null || status.error !== null) return '5h'
    for (const window of windowsFor(model, this.plan.derive)) {
      if (!isUsable({ ...status, rows: status.rows.filter(r => r.window === window) }, model, this.plan.derive)) {
        return window
      }
    }
    return windowsFor(model, this.plan.derive)[0] ?? '5h'
  }

  /**
   * Deliver one announcement.
   *
   * The record has already been consumed by `settle`, so a throw here costs
   * the message rather than producing a duplicate on the next probe. A double
   * "your quota reset, resume" is worse than a dropped one, because the agent
   * resumes work it already resumed.
   */
  private deliver(notice: EdgeNotice): void {
    const agent = this.ctx.agents.get(notice.sessionId)
    if (agent === undefined) return
    agent.followup(createQuotaNotice(noticeText(notice.facts), noticeSummary(notice.facts)))
  }

  /** Drop a session's outstanding record, e.g. because it changed route. */
  forget(sessionId: SessionId): void {
    this.state = withoutBlock(this.state, sessionId)
  }

  /**
   * The blocked-window marker survives a restart, so a window that ran out
   * while the host was down still wakes on the first healthy read after boot.
   * Best-effort by design: a filesystem that cannot be written must not stop
   * the row from running.
   */
  private persistMarker(): void {
    if (this.config.markerPath === '') return
    try {
      const { writeFileSync, rmSync } = require('node:fs') as typeof import('node:fs')
      if (this.accountBlocked) writeFileSync(this.config.markerPath, String(Date.now()))
      else rmSync(this.config.markerPath, { force: true })
    } catch (error) {
      // Persistence is an optimisation: the in-memory state stays correct
      // without it. But a silent swallow here once hid a `require` that does
      // not exist in ESM, so this row looked healthy while writing nothing.
      // Anything swallowed is now reported.
      this.ctx.logger?.warn('dsh-quota: could not update the blocked-window marker', error)
    }
  }
}
