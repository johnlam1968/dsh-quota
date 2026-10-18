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
import { effectiveRows, isUsable } from './derive.js'
import type { DeriveSpec } from './derive.js'
import { nextDelay } from './schedule.js'
import type { Schedule } from './schedule.js'
import { noticeText } from './notice.js'
import { formatDuration, renderQuotaStatus } from './format.js'
import { createQuotaNotice } from './message.js'
import type { PlanStatus, QuotaWindow } from './types.js'

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
  /** The last successful reading; null until the first readable one. */
  private latest: PlanStatus | null = null
  /**
   * Whether the account was refusing requests at the previous successful read.
   *
   * This ONE BOOLEAN is the entire edge. The probe is the single source of truth
   * for account state, so nothing has to remember which session was blocked, or
   * decode a provider's refusal wording to work it out.
   */
  private wasBlocked = false
  private errorStreak = 0
  /** Session id → the disposers of its prompt line and tool, plus its model. */
  private readonly bound = new Map<SessionId, { model: string; disposers: Array<() => void> }>()
  /** Sessions whose opening quota briefing has already been rendered. */
  private readonly seeded = new Set<SessionId>()
  /** Built once at mount; see the constructor for why it is not per-session. */
  private readonly statusTool: ToolDefinition
  /** Used only when a tool call arrives with no agent, which should not happen. */
  private readonly fallbackModel = ''

  constructor(ctx: Context, config: QuotaConfig) {
    super(ctx, 'quota')
    this.config = config
    this.plan = definePlan(config)

    // `agent/created` is a SERIAL dispatch: a throw here FAILS THE CREATION,
    // so a defect in an advisory plugin would take down every new session in
    // the host. Everything below is therefore contained, and anything it
    // swallows is reported rather than lost.
    this.ctx.on('agent/created', ({ agent }): undefined => {
     try {
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
      // A resumed session may already have a committed route. A session
      // created FOR its first request has none: `requestContext()` is
      // undefined and the `request/context` event lands after that step's
      // assembly, so a cold session would go a whole turn with neither the
      // prompt line nor the tool. Fall back to the agent's own options — the
      // same source `onReset` already trusts to decide who to wake. If that
      // guess is wrong the first `request/context` reconciles again and
      // `detach()`s, and reconcile is idempotent either way.
      const current = agent.session.requestContext()
      if (current !== undefined) this.reconcile(agent, current.provider, current.model)
      else if (agent.options.provider !== undefined) {
        this.reconcile(agent, agent.options.provider, agent.options.model ?? '')
      }
     } catch (error) {
      this.ctx.logger?.warn('dsh-quota: could not subscribe a session; continuing without it', error)
     }
    })

    // A closed session's agent is disposed but its id keeps living in `bound`
    // and `seeded` — nothing else clears them, because `detach` is only reached
    // on a ROUTE change. Two consequences, both silent:
    //
    //   - the entry leaks: one dead id and two dead disposers, per closed
    //     session, for the life of the process;
    //   - worse, `seeded` survives, so reopening that session in the SAME host
    //     process finds its one briefing already spent and renders nothing —
    //     the agent gets no quota status at all on reactivation.
    //
    // The harness contains listener failures on this event, so a throw here
    // cannot break the disposal it is cleaning up after.
    this.ctx.on('agent/disposed', ({ agent }): undefined => {
      this.detach(agent.id)
    })

    // Built ONCE here rather than per subscription. defineTool validates its
    // definition at call time, so a per-subscription call would surface a
    // schema error during `agent/created` — a SERIAL dispatch, where a throw
    // FAILS SESSION CREATION rather than just this plugin. At mount it can
    // only fail this fiber.
    this.statusTool = defineTool({
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
      // The model comes from the CALLING agent, not a closure — which is what
      // lets one definition serve every session.
      execute: async (_args, exec) => {
        const model = (exec.agent as Agent | undefined)?.options.model ?? this.fallbackModel
        return this.statusReport(model)
      },
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
        // SEEDED ONCE per session, then never again — this is the opening
        // briefing, not a standing line. A countdown written into a prompt is
        // stale the moment it is read, and re-sending it every step would be
        // wallpaper carrying wrong numbers. The tool is the live path.
        //
        // It is not marked as seeded until it actually renders something, so a
        // session created before the first successful probe does not spend its
        // one briefing on an empty string — it gets the next step instead.
        text: () => {
          if (this.seeded.has(agent.id)) return ''
          // Read the model from the binding, not from this closure's capture: a
          // model switch within the same plan updates `existing.model` without
          // re-registering, so a captured `model` would go stale here.
          const line = renderQuotaStatus(
            this.latest,
            this.bound.get(agent.id)?.model ?? model,
            this.plan.derive,
            this.config.lowWaterMarkPercent,
          )
          if (line !== '') this.seeded.add(agent.id)
          return line
        },
      }),
    )
    disposers.push(agent.ctx.tools.register(this.statusTool))
    this.bound.set(agent.id, { model, disposers })
  }

  /** Drop a session's quota surface: its prompt line and its tool. */
  private detach(sessionId: SessionId): void {
    const existing = this.bound.get(sessionId)
    if (existing === undefined) return
    this.bound.delete(sessionId)
    // A session that comes back on the watched provider gets its briefing again.
    this.seeded.delete(sessionId)
    for (const dispose of [...existing.disposers].reverse()) dispose()
  }

  /** The one payload the tool and the prompt line both derive from. */
  private statusReport(model: string): StatusPayload {
    const status = this.latest
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
    return this.latest
  }

  /** Read now instead of waiting for the timer, and settle the result. */
  async refresh(): Promise<PlanStatus> {
    await this.tick()
    return this.latest ?? this.errorStatus('no status available')
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

    // An unreadable reading says nothing about the window. Change nothing but
    // the streak, so a dropped request can never be mistaken for a reset.
    if (next.error !== null) {
      this.errorStreak++
      return nextDelay(next, true, now, this.plan.schedule, this.errorStreak, Math.random())
    }
    this.errorStreak = 0
    const previous = this.latest
    this.latest = next

    const blocked = !isUsable(next, this.plan.probe.entry, this.plan.derive)
    if (this.wasBlocked && !blocked) this.onReset(next, previous)
    this.wasBlocked = blocked

    this.ctx.emit('quota/changed', { status: next })
    return nextDelay(next, !blocked, now, this.plan.schedule, 0, Math.random())
  }

  /**
   * The account recovered. Tell the sessions using it.
   *
   * Three bounds keep a redundant wake rare and harmless, and none of them
   * needs per-session memory of what happened:
   *   - idle only, so a running turn is never interrupted;
   *   - the session's own model must be usable NOW, so a video model is not
   *     woken by a 5-hour window that never gated it;
   *   - the announcement is already hedged about whether this session's work
   *     was the thing that got cut off.
   */
  private onReset(recovered: PlanStatus, previous: PlanStatus | null): void {
    // Which window recovered. At this point every row reads healthy, so the
    // CURRENT status cannot answer it — it has to come from the reading before
    // the edge: a window that was blocked then and is not blocked now.
    const window = previous?.rows.find(
      (row) => row.blocked && !recovered.rows.some((r) => r.window === row.window && r.blocked),
    )?.window

    if (window === undefined) return   // no window to name: say nothing rather than guess

    for (const agent of this.ctx.agents.list()) {
      if (agent.options.provider !== this.config.provider) continue
      if (agent.status !== 'idle') continue
      const model = agent.options.model ?? ''
      if (!isUsable(recovered, model, this.plan.derive)) continue

      agent.followup(
        createQuotaNotice(
          noticeText({
            provider: this.config.provider,
            model,
            spec: this.plan.derive,
            status: recovered,
            window,
          }),
          `${this.config.provider} usage window reset — blocked work may resume`,
        ),
      )
    }
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

}
