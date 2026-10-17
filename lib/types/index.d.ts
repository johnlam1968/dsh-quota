import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';
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
        credentialFile: import("@deepseek-ai/schemastery").default<string, string, "defined">;
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
        credentialFile: import("@deepseek-ai/schemastery").default<string, string, "defined">;
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
    /** The last successful reading; null until the first readable one. */
    private latest;
    /**
     * Whether the account was refusing requests at the previous successful read.
     *
     * This ONE BOOLEAN is the entire edge. The probe is the single source of truth
     * for account state, so nothing has to remember which session was blocked, or
     * decode a provider's refusal wording to work it out.
     */
    private wasBlocked;
    private errorStreak;
    /** Session id → the disposers of its prompt line and tool, plus its model. */
    private readonly bound;
    /** Sessions whose opening quota briefing has already been rendered. */
    private readonly seeded;
    /** Built once at mount; see the constructor for why it is not per-session. */
    private readonly statusTool;
    /** Used only when a tool call arrives with no agent, which should not happen. */
    private readonly fallbackModel;
    constructor(ctx: Context, config: QuotaConfig);
    /** Attach, refresh, or drop one session's quota surface. Idempotent. */
    private reconcile;
    /** Drop a session's quota surface: its prompt line and its tool. */
    private detach;
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
    private onReset;
    /** One self-rescheduling timer, owned by a single effect. */
    private armTimer;
}
