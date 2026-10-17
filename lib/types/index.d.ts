import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { QuotaConfig } from './config.js';
import type { PlanStatus } from './types.js';
declare module '@deepseek-ai/cordis' {
    interface Events {
        /** Emitted after every probe that produced a readable status. */
        'quota/changed'(payload: {
            status: PlanStatus;
        }): void;
    }
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        quota: QuotaService;
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
        'model/selection': {
            provider: string;
            model: string;
            reasoningEffort?: string;
        };
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
    static inject: string[];
    static Config: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<NoInfer<{
        provider: import("@deepseek-ai/schemastery").default<string, string, "plain">;
        entry: import("@deepseek-ai/schemastery").default<string, string, "defined">;
        endpoint: import("@deepseek-ai/schemastery").default<string, string, "plain">;
        authEnv: import("@deepseek-ai/schemastery").default<string, string, "plain">;
        requestTimeoutMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        readAttempts: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        videoModelPatterns: import("@deepseek-ai/schemastery").default<string[], string[], "defined">;
        videoEntry: import("@deepseek-ai/schemastery").default<string, string, "defined">;
        blockPatterns: import("@deepseek-ai/schemastery").default<string[], string[], "defined">;
        lowWaterMarkPercent: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        schedule: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<NoInfer<{
            divisor: import("@deepseek-ai/schemastery").default<number, number, "defined">;
            minIntervalMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
            maxIntervalMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
            skewMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
            baseBackoffMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
            maxBackoffMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
            jitterRatio: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        }>>, Schemastery.ObjectT<NoInfer<{
            divisor: import("@deepseek-ai/schemastery").default<number, number, "defined">;
            minIntervalMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
            maxIntervalMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
            skewMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
            baseBackoffMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
            maxBackoffMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
            jitterRatio: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        }>>, "defined">;
        markerPath: import("@deepseek-ai/schemastery").default<string, string, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        provider: import("@deepseek-ai/schemastery").default<string, string, "plain">;
        entry: import("@deepseek-ai/schemastery").default<string, string, "defined">;
        endpoint: import("@deepseek-ai/schemastery").default<string, string, "plain">;
        authEnv: import("@deepseek-ai/schemastery").default<string, string, "plain">;
        requestTimeoutMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        readAttempts: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        videoModelPatterns: import("@deepseek-ai/schemastery").default<string[], string[], "defined">;
        videoEntry: import("@deepseek-ai/schemastery").default<string, string, "defined">;
        blockPatterns: import("@deepseek-ai/schemastery").default<string[], string[], "defined">;
        lowWaterMarkPercent: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        schedule: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<NoInfer<{
            divisor: import("@deepseek-ai/schemastery").default<number, number, "defined">;
            minIntervalMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
            maxIntervalMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
            skewMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
            baseBackoffMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
            maxBackoffMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
            jitterRatio: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        }>>, Schemastery.ObjectT<NoInfer<{
            divisor: import("@deepseek-ai/schemastery").default<number, number, "defined">;
            minIntervalMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
            maxIntervalMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
            skewMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
            baseBackoffMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
            maxBackoffMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
            jitterRatio: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        }>>, "defined">;
        markerPath: import("@deepseek-ai/schemastery").default<string, string, "defined">;
    }>>, "plain">;
    private readonly config;
    private readonly plan;
    private state;
    private accountBlocked;
    /** Session id → the disposers of its prompt line and tool, plus its model. */
    private readonly bound;
    constructor(ctx: Context, config: QuotaConfig);
    /** Attach, refresh, or drop one session's quota surface. Idempotent. */
    private reconcile;
    /** Drop a session's quota surface and its outstanding block record. */
    private detach;
    /**
     * The `quota_status` tool.
     *
     * Two rules the guard enforces here, both found by loading the built bundle
     * rather than by reading docs: a nullable field is
     * `oneOf: [{type:'number'},{type:'null'}]` and never `type: ['number','null']`,
     * and an `output.schema` object node carries NO `required` — the value schema
     * DSL rejects it at registration.
     */
    private buildStatusTool;
    /** The one payload the tool and the prompt line both derive from. */
    private statusReport;
    /** The current detached status, or null before the first read. */
    status(): PlanStatus | null;
    /** Read now instead of waiting for the timer, and settle the result. */
    refresh(): Promise<PlanStatus>;
    private get deriveSpec();
    private errorStatus;
    /** One HTTP attempt. Never throws; every failure becomes a readable error. */
    private readOnce;
    /**
     * One logical read.
     *
     * A single call is not one fact. The first readable verdict wins, because
     * a dropped request must never be the thing that decides the state.
     */
    private read;
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
    private tick;
    /** One self-rescheduling timer, owned by a single effect. */
    private armTimer;
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
    private recordBlock;
    /** Which window will gate this model right now. */
    private windowFor;
    /**
     * Deliver one announcement.
     *
     * The record has already been consumed by `settle`, so a throw here costs
     * the message rather than producing a duplicate on the next probe. A double
     * "your quota reset, resume" is worse than a dropped one, because the agent
     * resumes work it already resumed.
     */
    private deliver;
    /** Drop a session's outstanding record, e.g. because it changed route. */
    forget(sessionId: SessionId): void;
    /**
     * The blocked-window marker survives a restart, so a window that ran out
     * while the host was down still wakes on the first healthy read after boot.
     * Best-effort by design: a filesystem that cannot be written must not stop
     * the row from running.
     */
    private persistMarker;
}
