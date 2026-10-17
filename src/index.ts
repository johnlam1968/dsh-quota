import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
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
import { noticeSummary, noticeText } from './notice.js'
import { EMPTY_STATE, settle, withBlock, withoutBlock } from './state.js'
import type { EdgeNotice, QuotaState } from './state.js'
import type { BlockRecord, PlanStatus, QuotaWindow } from './types.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A quota reset announcement delivered into a session. */
    'quota-notice': { kind: 'quota-notice' } & ContextFormed
  }
}

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

    // Observing failures is the whole trigger for the wake: this is the one
    // place the provider's refusal reaches us, and it carries the session.
    this.ctx.on('agent/request-error', async (payload, next) => {
      this.recordBlock(payload.agent.id, payload.failure)
      return await next()
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

  /** Remember that a session was refused, so its reset can wake it. */
  private recordBlock(sessionId: SessionId, failure: { message: string; code: string; status?: number }): void {
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
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: noticeText(notice.facts) }],
        source: {
          kind: 'quota-notice',
          form: 'notice',
          summary: noticeSummary(notice.facts),
        },
      }),
    )
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
    } catch {
      // Persistence is an optimisation; the in-memory state remains correct.
    }
  }
}
