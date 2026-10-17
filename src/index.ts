import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'

import { Config, definePlan } from './config.js'
import type { PlanDefinition, QuotaConfig } from './config.js'
import { classifyQuota } from './probe.js'
import { effectiveRows, isUsable, windowsFor } from './derive.js'
import type { DeriveSpec } from './derive.js'
import { nextDelay } from './schedule.js'
import type { Schedule } from './schedule.js'
import { matchesBlock } from './block.js'
import type { FailureLike } from './block.js'
import { noticeSummary, noticeText } from './notice.js'
import { formatDuration, renderQuotaStatus } from './format.js'
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
 * HARNESS DECLARATION GAP (not ours to fix — reporting it instead).
 *
 * The runtime DOES append `model/selection`: `dsh-api-session-controller` calls
 * `session.append('model/selection', selection)` on every model selection made
 * through the Web UI picker or the `select_model` tool, and the event is listed
 * in `dsh-session/lib/types/known-event-types.js`. But it is absent from the
 * installed `SessionEventMap` in `dsh-session/lib/types/types.d.ts`, so
 * TypeScript narrows `event.type === 'model/selection'` to `never` and the
 * payload is unreachable. `docs/subsystems/session.md` documents the map as
 * merge-extensible, so merging it back is the sanctioned shape; the payload
 * below is the one observed in a real session log.
 */
declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    'model/selection': { provider: string; model: string; reasoningEffort?: string }
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

/** What `quota_status` reports. Every field is required so it satisfies the schema. */
interface StatusPayload {
  readonly known: boolean
  readonly provider: string
  readonly usable: boolean
  // A mutable array, because `InferValue` infers one from the schema's
  // `type: 'array'` node and will not accept a `readonly` array back.
  readonly windows: {
    window: QuotaWindow
    blocked: boolean
    remainingPercent: number | null
    resetsInMs: number | null
  }[]
}

/**
 * The shape `defineTool` INFERRS from `output.schema`.
 *
 * `output.schema` is a VALUE schema spec, whose object nodes accept only
 * `type`, `properties` and `additionalProperties` — `required` is rejected at
 * registration with "schema.required is not supported by the value schema DSL".
 * Every property therefore arrives optional. Rather than cast at the boundary,
 * the renderer states the looser shape it receives and tolerates the absent
 * fields; `execute` still returns every field.
 */
interface InferredStatus {
  readonly usable?: boolean | undefined
  readonly provider?: string | undefined
  readonly known?: boolean | undefined
  readonly windows?: readonly {
    readonly window?: string | undefined
    readonly blocked?: boolean | undefined
    readonly remainingPercent?: number | null | undefined
    readonly resetsInMs?: number | null | undefined
  }[] | undefined
}

/** Turn a status payload into the one paragraph the model reads. */
function renderStatusReport(payload: InferredStatus): string {
  const provider = payload.provider ?? 'this provider'
  if (payload.known !== true) {
    return `No quota reading for ${provider} is available yet. Nothing is known about its usage windows; do not infer that requests would be refused.`
  }
  const lines = (payload.windows ?? []).map(row => {
    const label = row.window === '5h' ? '5-hour' : (row.window ?? 'usage')
    const pctText = row.remainingPercent === null || row.remainingPercent === undefined
      ? 'remaining unreported'
      : `${row.remainingPercent}% remaining`
    if (row.blocked === true) {
      return row.resetsInMs === null || row.resetsInMs === undefined
        ? `${label} window: EXHAUSTED, no countdown reported`
        : `${label} window: EXHAUSTED, resets in ${formatDuration(row.resetsInMs)}`
    }
    return row.resetsInMs === null || row.resetsInMs === undefined
      ? `${label} window: open, ${pctText}`
      : `${label} window: open, ${pctText}, resets in ${formatDuration(row.resetsInMs)}`
  })
  const head = payload.usable === true
    ? `Requests to ${provider} are currently ACCEPTED.`
    : `Requests to ${provider} are currently being REFUSED by a usage limit. This is temporary — do not retry in a loop.`
  return [head, ...lines].join('\n')
}

/**
 * Resolve the bearer token: environment first, then the credential file.
 *
 * The environment wins so a deployment can override without touching the file.
 * Both sources are read defensively — a malformed file yields no token rather
 * than an exception inside the probe loop.
 */
function bearer(envName: string, credentialFile: string): string | undefined {
  const fromEnv = process.env[envName]
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  if (credentialFile === '') return undefined

  try {
    const path = credentialFile.startsWith('~')
      ? join(homedir(), credentialFile.slice(1))
      : credentialFile
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const key = (parsed as Record<string, unknown>)['api_key']
    return typeof key === 'string' && key.length > 0 ? key : undefined
  } catch {
    // No file, unreadable, or not JSON: simply no credential.
    return undefined
  }
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
  static inject = ['agents', 'systemPrompt', 'tools']
  static Config = Config

  private readonly config: QuotaConfig
  private readonly plan: PlanDefinition
  private state: QuotaState = EMPTY_STATE
  private accountBlocked = false
  /** Session id → the disposers of its prompt line and tool, plus its model. */
  private readonly bound = new Map<SessionId, { model: string; disposers: Array<() => void> }>()

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

    this.ctx.on('agent/created', ({ agent }): undefined => {
      // Subscription follows the session's route, so it has to be recomputed
      // whenever that route changes rather than decided once. Two triggers:
      //   model/selection — intent, appended by the selection funnel before the
      //     next turn, so the first prompt assembly after a switch is correct.
      //     (Its declaration is missing from the installed SessionEventMap; see
      //     the merge above.)
      //   request/context — commitment, written by the loop before dispatch on
      //     every path. It lands AFTER that step's assembly, which is why
      //     intent is observed too.
      agent.ctx.on('session/event', (_session, event) => {
        if (event.type === 'model/selection') {
          this.reconcile(agent, event.data.provider, event.data.model)
        }
        if (event.type === 'request/context') {
          this.reconcile(agent, event.data.provider, event.data.model)
        }
      })
      // A resumed session may already have a committed route.
      const current = agent.session.requestContext()
      if (current !== undefined) this.reconcile(agent, current.provider, current.model)
    })

    this.ctx.effect(() => this.armTimer())
  }

  /** Attach, refresh, or drop one session's quota surface. Idempotent. */
  private reconcile(agent: Agent, provider: string, model: string): void {
    if (provider !== this.config.provider) {
      this.detach(agent.id)
      return
    }
    const existing = this.bound.get(agent.id)
    if (existing !== undefined) {
      if (existing.model === model) return
      // A model change within the same plan only needs the text refreshed; the
      // tool schema and its registration stay exactly as they are.
      existing.model = model
      return
    }

    const disposers: Array<() => void> = []
    disposers.push(
      agent.ctx.systemPrompt.context({
        name: 'quota-usage-status',
        order: 900,
        text: () => renderQuotaStatus(this.state.status, model, this.plan.derive, this.config.lowWaterMarkPercent),
      }),
    )
    disposers.push(agent.ctx.tools.register(this.buildStatusTool(model)))
    this.bound.set(agent.id, { model, disposers })
  }

  /** Drop a session's quota surface and its outstanding block record. */
  private detach(sessionId: SessionId): void {
    const existing = this.bound.get(sessionId)
    if (existing === undefined) return
    this.bound.delete(sessionId)
    for (const dispose of [...existing.disposers].reverse()) dispose()
    this.forget(sessionId)
  }

  /**
   * The `quota_status` tool.
   *
   * Two rules the guard enforces here, both found by loading the built bundle
   * rather than by reading docs: a nullable field is
   * `oneOf: [{type:'number'},{type:'null'}]` and never `type: ['number','null']`,
   * and an `output.schema` object node carries NO `required` — the value schema
   * DSL rejects it at registration.
   */
  private buildStatusTool(model: string): ToolDefinition {
    return defineTool({
      name: 'quota_status',
      description:
        'Report this session\'s provider usage-window state: whether requests are being refused, '
        + 'the percent remaining in each window, and when each window resets. '
        + 'Call this before concluding that a provider is unavailable — a usage limit is '
        + 'temporary and announces its own reset.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            known: { type: 'boolean' },
            provider: { type: 'string' },
            usable: { type: 'boolean' },
            windows: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  window: { type: 'string' },
                  blocked: { type: 'boolean' },
                  remainingPercent: { oneOf: [{ type: 'number' }, { type: 'null' }] },
                  resetsInMs: { oneOf: [{ type: 'number' }, { type: 'null' }] },
                },
              },
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderStatusReport(value) }],
      },
      // An arrow, not a method shorthand: a shorthand's `this` is the options
      // object, not the row.
      execute: async () => this.statusReport(model),
    })
  }

  /** The one payload the tool and the prompt line both derive from. */
  private statusReport(model: string): StatusPayload {
    const status = this.state.status
    if (status === null || status.error !== null) {
      return { known: false, provider: this.config.provider, usable: true, windows: [] }
    }
    return {
      known: true,
      provider: status.provider,
      usable: isUsable(status, model, this.plan.derive),
      windows: effectiveRows(status.rows, model, this.plan.derive).map(row => ({
        window: row.window,
        blocked: row.blocked,
        remainingPercent: row.remainingPercent,
        resetsInMs: row.resetAt === null ? null : Math.max(0, row.resetAt - status.checkedAt),
      })),
    }
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
    const token = bearer(this.config.authEnv, this.config.credentialFile)
    if (token === undefined) {
      return this.errorStatus(
        `no credential: ${this.config.authEnv} is unset and ${this.config.credentialFile} yielded no api_key`,
      )
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
   * A failure from a route this row does not watch is not ours to record — a
   * blocked session on a fallback provider must not be woken by this plan's
   * reset.
   *
   * `provider` is the route the failure is ATTRIBUTED to, and the two channels
   * do not supply it the same way: `agent/request-error` carries the route
   * that served the failed request, while `agent/error` carries none and its
   * caller passes the agent's CURRENT route.
   *
   * That leaves one accepted limitation on `agent/error`: a session that
   * changed route between the failure and its surfacing is judged by the route
   * it holds now, which can drop a real block — the session is never woken — or
   * attribute a foreign one. Dropping the filter instead would trade that for
   * a wake on every unrelated error, and an advisory row that stays quiet
   * unless its own window ran out is worth more than one that never misses.
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
