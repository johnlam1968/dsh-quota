// src/index.ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Service } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";

// src/config.ts
import z from "@deepseek-ai/schemastery";
var Config = z.object({
  /** Provider route id this row watches. Matched against `LlmCallConfig.provider`. */
  provider: z.string(),
  /** `model_name` carrying the account-wide rolling interval. */
  entry: z.string().default("general"),
  /** Quota endpoint. The bearer token is read from `authEnv`, never inlined. */
  endpoint: z.string(),
  /** Name of the environment variable holding the bearer token. */
  authEnv: z.string(),
  /**
   * Fallback credential file, read for an `api_key` when `authEnv` is unset.
   *
   * The MiniMax CLI already keeps a working credential at `~/.mmx/config.json`,
   * so without this the row mounts and then reports every read as
   * unauthenticated — mounted but blind. Empty disables the fallback.
   */
  credentialFile: z.string().default("~/.mmx/config.json"),
  /** Per-request timeout for the quota read, in ms. */
  requestTimeoutMs: z.natural().min(1).default(15e3),
  /**
   * How many attempts one read gets. A dropped call must never be the thing
   * that decides the state, so the first readable verdict wins.
   */
  readAttempts: z.natural().min(1).default(3),
  /** Models exempt from the 5-hour window, i.e. subject to the weekly one only. */
  videoModelPatterns: z.array(z.string()).default(["^video$", "-video", "video-"]),
  /**
   * The `model_remains[]` entry holding video budgets. Observed live alongside
   * `general`. Empty disables video-entry routing, leaving video models on the
   * account-wide row.
   */
  videoEntry: z.string().default("video"),
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
  blockPatterns: z.array(z.string()).default([
    "usage limit exceeded",
    "\\b2056\\b",
    "insufficient[\\s_-]+(?:quota|balance|credits?)"
  ]),
  /** Below this remaining percent, a healthy plan is worth mentioning. */
  lowWaterMarkPercent: z.number().min(0).max(100).default(20),
  schedule: z.object({
    /** How many equal slices to divide the remaining wait into. */
    divisor: z.natural().min(1).default(4),
    /** Floor for a probing interval, in ms. Stops a spin loop near a boundary. */
    minIntervalMs: z.natural().min(1).default(15e3),
    /** Ceiling for a probing interval, in ms. Bounds how long a new block goes unseen. */
    maxIntervalMs: z.natural().min(1).default(9e5),
    /** How long past a reported boundary to wait before confirming. */
    skewMs: z.natural().min(0).default(3e4),
    /** First backoff step after a failed read, in ms. */
    baseBackoffMs: z.natural().min(1).default(1e3),
    /** Backoff ceiling after repeated failures, in ms. */
    maxBackoffMs: z.natural().min(1).default(3e5),
    /** Fractional spread on every delay, so two hosts do not sync up. */
    jitterRatio: z.number().min(0).max(0.5).default(0.1)
  }).default({}),
  /** Where the blocked-window marker is written. Empty disables persistence. */
  markerPath: z.string().default("")
});
function definePlan(config) {
  const compile = (sources, flags) => sources.map((source) => {
    try {
      return new RegExp(source, flags);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`dsh-quota: invalid pattern ${JSON.stringify(source)}: ${reason}`);
    }
  });
  try {
    new URL(config.endpoint);
  } catch {
    throw new Error(`dsh-quota: endpoint is not a URL: ${JSON.stringify(config.endpoint)}`);
  }
  return {
    probe: { provider: config.provider, entry: config.entry },
    derive: {
      entry: config.entry,
      videoModelPatterns: compile(config.videoModelPatterns, "i"),
      videoEntry: config.videoEntry === "" ? null : config.videoEntry
    },
    blockPatterns: compile(config.blockPatterns, "i"),
    schedule: {
      divisor: config.schedule.divisor,
      minIntervalMs: config.schedule.minIntervalMs,
      maxIntervalMs: config.schedule.maxIntervalMs,
      skewMs: config.schedule.skewMs,
      baseBackoffMs: config.schedule.baseBackoffMs,
      maxBackoffMs: config.schedule.maxBackoffMs,
      jitterRatio: config.schedule.jitterRatio
    }
  };
}

// src/probe.ts
var STATUS_EXHAUSTED = 2;
function failed(provider, now, error) {
  return { provider, checkedAt: now, rows: [], error };
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function isPositiveCountdown(value) {
  return isFiniteNumber(value) && value > 0;
}
function narrowPercent(value) {
  return isFiniteNumber(value) ? value : null;
}
function narrowNumber(value) {
  return isFiniteNumber(value) ? value : null;
}
function narrowCountdown(value, now) {
  return isPositiveCountdown(value) ? now + value : null;
}
function classifyQuota(body, now, spec) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return failed(spec.provider, now, "response was not JSON");
  }
  if (!isRecord(parsed)) {
    return failed(spec.provider, now, "response was not a JSON object");
  }
  const remains = parsed["model_remains"];
  if (!Array.isArray(remains)) {
    return failed(spec.provider, now, "model_remains was missing or not an array");
  }
  const rows = [];
  for (const raw of remains) {
    if (!isRecord(raw)) continue;
    const entry = raw["model_name"];
    if (typeof entry !== "string" || entry.length === 0) continue;
    const pct = narrowPercent(raw["current_interval_remaining_percent"]);
    rows.push({
      entry,
      window: "5h",
      blocked: narrowNumber(raw["current_interval_status"]) === STATUS_EXHAUSTED || pct === 0,
      remainingPercent: pct,
      resetAt: narrowCountdown(raw["remains_time"], now)
    });
    const weeklyPct = narrowPercent(raw["current_weekly_remaining_percent"]);
    rows.push({
      entry,
      window: "weekly",
      // Percentage only. `current_weekly_status` is deliberately NOT consulted.
      blocked: weeklyPct === 0,
      remainingPercent: weeklyPct,
      resetAt: narrowCountdown(raw["weekly_remains_time"], now)
    });
  }
  const sawEntry = rows.some((row) => row.entry === spec.entry);
  if (!sawEntry) {
    return failed(spec.provider, now, `no \`${spec.entry}\` entry in model_remains`);
  }
  return { provider: spec.provider, checkedAt: now, rows, error: null };
}

// src/derive.ts
function isVideoModel(model, spec) {
  return spec.videoModelPatterns.some((pattern) => pattern.test(model));
}
function windowsFor(model, spec) {
  return isVideoModel(model, spec) ? ["weekly"] : ["5h", "weekly"];
}
function rowFor(rows, model, spec, window) {
  const video = isVideoModel(model, spec) ? spec.videoEntry : null;
  return rows.find((row) => row.entry === model && row.window === window) ?? // A video model's budget lives in its own entry, so it outranks the
  // account-wide row; otherwise a video model would be judged by the text
  // model's 5-hour interval, which does not gate it at all.
  (video === null ? void 0 : rows.find((row) => row.entry === video && row.window === window)) ?? rows.find((row) => row.entry === spec.entry && row.window === window);
}
function deriveUsable(rows, model, spec) {
  return windowsFor(model, spec).every(
    (window) => rowFor(rows, model, spec, window)?.blocked !== true
  );
}
function effectiveRows(rows, model, spec) {
  const resolved = [];
  for (const window of windowsFor(model, spec)) {
    const row = rowFor(rows, model, spec, window);
    if (row !== void 0) resolved.push(row);
  }
  return resolved;
}
function nextResetAt(rows) {
  const pending = rows.filter((row) => row.blocked && row.resetAt !== null).map((row) => row.resetAt);
  return pending.length === 0 ? null : Math.min(...pending);
}
function isUsable(status, model, spec) {
  if (status === null || status.error !== null) return true;
  return deriveUsable(status.rows, model, spec);
}

// src/schedule.ts
function jittered(delayMs, ratio, salt) {
  const factor = 1 + ratio * (salt * 2 - 1);
  return Math.max(1, Math.round(delayMs * factor));
}
function nextDelay(status, usable, now, cfg, errorStreak, salt) {
  if (status.error !== null) {
    const backoff = Math.min(cfg.maxBackoffMs, cfg.baseBackoffMs * 2 ** errorStreak);
    return { delayMs: jittered(backoff, cfg.jitterRatio, salt), reason: "read-failed" };
  }
  if (usable) {
    return { delayMs: jittered(cfg.maxIntervalMs, cfg.jitterRatio, salt), reason: "usable" };
  }
  const resetAt = nextResetAt(status.rows);
  if (resetAt === null) {
    return { delayMs: jittered(cfg.maxIntervalMs, cfg.jitterRatio, salt), reason: "blocked-no-countdown" };
  }
  const until = resetAt - now;
  if (until <= cfg.skewMs) {
    return { delayMs: jittered(cfg.skewMs, cfg.jitterRatio, salt), reason: "boundary-now" };
  }
  const sliced = until / cfg.divisor;
  const clamped = Math.min(Math.max(sliced, cfg.minIntervalMs), cfg.maxIntervalMs);
  return { delayMs: jittered(clamped, cfg.jitterRatio, salt), reason: "counting-down" };
}

// src/format.ts
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "an unknown time";
  const totalSeconds = Math.round(ms / 1e3);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
}
function windowLabel(window) {
  return window === "5h" ? "5-hour" : "weekly";
}
function windowPhrase(status, model, spec) {
  const parts = [];
  for (const row of effectiveRows(status.rows, model, spec)) {
    const label = windowLabel(row.window);
    if (row.blocked) {
      parts.push(
        row.resetAt === null ? `${label} window exhausted` : `${label} window exhausted, resets ${formatDuration(row.resetAt - status.checkedAt)}`
      );
      continue;
    }
    const pct = row.remainingPercent;
    parts.push(
      pct === null ? `${label} window open (remaining unreported)` : `${label} window ${pct}% remaining`
    );
  }
  return parts.length === 0 ? null : parts.join("; ");
}
function renderQuotaStatus(status, model, spec, lowWaterMarkPercent) {
  if (status === null || status.error !== null) return "";
  const usable = isUsable(status, model, spec);
  const phrase = windowPhrase(status, model, spec);
  const who = `${status.provider} \u2014 `;
  if (!usable) {
    return `<provider-quota>${who}${phrase ?? "usage window exhausted"}. Requests to this provider are being refused until it resets; this is a quota limit, not a fault. Do not retry in a loop \u2014 work on something else, or wait for the reset.</provider-quota>`;
  }
  if (phrase === null) return "";
  const low = effectiveRows(status.rows, model, spec).some(
    (row) => !row.blocked && row.remainingPercent !== null && row.remainingPercent <= lowWaterMarkPercent
  );
  return low ? `<provider-quota>${who}${phrase}. Usage is low enough to be worth pacing; save the remaining budget for work that needs this model.</provider-quota>` : `<provider-quota>${who}${phrase}. Requests to this provider are being accepted.</provider-quota>`;
}

// src/notice.ts
function blockedPhrase(facts) {
  return `the ${windowLabel(facts.window)} usage window`;
}
function runwayPhrase(facts) {
  const row = rowFor(facts.status.rows, facts.model, facts.spec, facts.window);
  if (row === void 0 || row.resetAt === null) return null;
  return formatDuration(row.resetAt - facts.status.checkedAt);
}
function noticeText(facts) {
  const { provider } = facts;
  const runway = runwayPhrase(facts);
  return `Quota notice for ${provider}: ${blockedPhrase(facts)} was exhausted and has reset` + (runway === null ? "." : `, giving you ${runway} of fresh window before it fills again.`) + `

Your provider is reachable again. If work you were doing was cut short by that limit, pick it up exactly where it stopped \u2014 the interrupted turn and everything before it are still in this conversation. If nothing was interrupted, carry on with whatever you were asked to do next. Use the quota status tool if you want the current numbers before committing to a long run.`;
}

// src/message.ts
import { randomUUID } from "node:crypto";
function createQuotaNotice(text, summary) {
  const block = Object.freeze({ type: "text", text });
  const content = Object.freeze([block]);
  return Object.freeze({
    role: "user",
    id: randomUUID(),
    content,
    source: Object.freeze({ kind: "quota-notice", form: "notice", summary })
  });
}

// src/index.ts
function renderStatusReport(payload) {
  const provider = payload.provider ?? "this provider";
  if (payload.known !== true) {
    return `No quota reading for ${provider} is available yet. Nothing is known about its usage windows; do not infer that requests would be refused.`;
  }
  const lines = (payload.windows ?? []).map((row) => {
    const label = row.window === "5h" ? "5-hour" : row.window ?? "usage";
    const pctText = row.remainingPercent === null || row.remainingPercent === void 0 ? "remaining unreported" : `${row.remainingPercent}% remaining`;
    if (row.blocked === true) {
      return row.resetsInMs === null || row.resetsInMs === void 0 ? `${label} window: EXHAUSTED, no countdown reported` : `${label} window: EXHAUSTED, resets in ${formatDuration(row.resetsInMs)}`;
    }
    return row.resetsInMs === null || row.resetsInMs === void 0 ? `${label} window: open, ${pctText}` : `${label} window: open, ${pctText}, resets in ${formatDuration(row.resetsInMs)}`;
  });
  const head = payload.usable === true ? `Requests to ${provider} are currently ACCEPTED.` : `Requests to ${provider} are currently being REFUSED by a usage limit. This is temporary \u2014 do not retry in a loop.`;
  return [head, ...lines].join("\n");
}
function bearer(envName, credentialFile) {
  const fromEnv = process.env[envName];
  if (fromEnv !== void 0 && fromEnv.length > 0) return fromEnv;
  if (credentialFile === "") return void 0;
  try {
    const path = credentialFile.startsWith("~") ? join(homedir(), credentialFile.slice(1)) : credentialFile;
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return void 0;
    const key = parsed["api_key"];
    return typeof key === "string" && key.length > 0 ? key : void 0;
  } catch {
    return void 0;
  }
}
var QuotaService = class extends Service {
  static inject = ["agents", "systemPrompt", "tools"];
  static Config = Config;
  config;
  plan;
  /** The last successful reading; null until the first readable one. */
  latest = null;
  /**
   * Whether the account was refusing requests at the previous successful read.
   *
   * This ONE BOOLEAN is the entire edge. The probe is the single source of truth
   * for account state, so nothing has to remember which session was blocked, or
   * decode a provider's refusal wording to work it out.
   */
  wasBlocked = false;
  errorStreak = 0;
  /** Session id → the disposers of its prompt line and tool, plus its model. */
  bound = /* @__PURE__ */ new Map();
  /** Sessions whose opening quota briefing has already been rendered. */
  seeded = /* @__PURE__ */ new Set();
  /** Built once at mount; see the constructor for why it is not per-session. */
  statusTool;
  /** Used only when a tool call arrives with no agent, which should not happen. */
  fallbackModel = "";
  constructor(ctx, config) {
    super(ctx, "quota");
    this.config = config;
    this.plan = definePlan(config);
    this.ctx.on("agent/created", ({ agent }) => {
      try {
        agent.ctx.on("session/event", (_session, event) => {
          if (event.type === "model/selection") {
            this.reconcile(agent, event.data.provider, event.data.model);
          }
          if (event.type === "request/context") {
            this.reconcile(agent, event.data.provider, event.data.model);
          }
        });
        const current = agent.session.requestContext();
        if (current !== void 0) this.reconcile(agent, current.provider, current.model);
        else if (agent.options.provider !== void 0) {
          this.reconcile(agent, agent.options.provider, agent.options.model ?? "");
        }
      } catch (error) {
        this.ctx.logger?.warn("dsh-quota: could not subscribe a session; continuing without it", error);
      }
    });
    this.statusTool = defineTool({
      name: "quota_status",
      description: "Report this session's provider usage-window state: whether requests are being refused, the percent remaining in each window, and when each window resets. Call this before concluding that a provider is unavailable \u2014 a usage limit is temporary and announces its own reset.",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            known: { type: "boolean" },
            provider: { type: "string" },
            usable: { type: "boolean" },
            windows: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  window: { type: "string" },
                  blocked: { type: "boolean" },
                  remainingPercent: { oneOf: [{ type: "number" }, { type: "null" }] },
                  resetsInMs: { oneOf: [{ type: "number" }, { type: "null" }] }
                }
              }
            }
          }
        },
        render: (_args, value) => [{ type: "text", text: renderStatusReport(value) }]
      },
      // The model comes from the CALLING agent, not a closure — which is what
      // lets one definition serve every session.
      execute: async (_args, exec) => {
        const model = exec.agent?.options.model ?? this.fallbackModel;
        return this.statusReport(model);
      }
    });
    this.ctx.effect(() => this.armTimer());
  }
  /** Attach, refresh, or drop one session's quota surface. Idempotent. */
  reconcile(agent, provider, model) {
    if (provider !== this.config.provider) {
      this.detach(agent.id);
      return;
    }
    const existing = this.bound.get(agent.id);
    if (existing !== void 0) {
      if (existing.model === model) return;
      existing.model = model;
      return;
    }
    const disposers = [];
    disposers.push(
      agent.ctx.systemPrompt.context({
        name: "quota-usage-status",
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
          if (this.seeded.has(agent.id)) return "";
          const line = renderQuotaStatus(
            this.latest,
            this.bound.get(agent.id)?.model ?? model,
            this.plan.derive,
            this.config.lowWaterMarkPercent
          );
          if (line !== "") this.seeded.add(agent.id);
          return line;
        }
      })
    );
    disposers.push(agent.ctx.tools.register(this.statusTool));
    this.bound.set(agent.id, { model, disposers });
  }
  /** Drop a session's quota surface: its prompt line and its tool. */
  detach(sessionId) {
    const existing = this.bound.get(sessionId);
    if (existing === void 0) return;
    this.bound.delete(sessionId);
    this.seeded.delete(sessionId);
    for (const dispose of [...existing.disposers].reverse()) dispose();
  }
  /** The one payload the tool and the prompt line both derive from. */
  statusReport(model) {
    const status = this.latest;
    if (status === null || status.error !== null) {
      return { known: false, provider: this.config.provider, usable: true, windows: [] };
    }
    return {
      known: true,
      provider: status.provider,
      usable: isUsable(status, model, this.plan.derive),
      windows: effectiveRows(status.rows, model, this.plan.derive).map((row) => ({
        window: row.window,
        blocked: row.blocked,
        remainingPercent: row.remainingPercent,
        resetsInMs: row.resetAt === null ? null : Math.max(0, row.resetAt - status.checkedAt)
      }))
    };
  }
  /** The current detached status, or null before the first read. */
  status() {
    return this.latest;
  }
  /** Read now instead of waiting for the timer, and settle the result. */
  async refresh() {
    await this.tick();
    return this.latest ?? this.errorStatus("no status available");
  }
  get deriveSpec() {
    return this.plan.derive;
  }
  errorStatus(error) {
    return { provider: this.config.provider, checkedAt: Date.now(), rows: [], error };
  }
  /** One HTTP attempt. Never throws; every failure becomes a readable error. */
  async readOnce(now) {
    const token = bearer(this.config.authEnv, this.config.credentialFile);
    if (token === void 0) {
      return this.errorStatus(
        `no credential: ${this.config.authEnv} is unset and ${this.config.credentialFile} yielded no api_key`
      );
    }
    try {
      const response = await fetch(this.config.endpoint, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(this.config.requestTimeoutMs)
      });
      if (!response.ok) {
        return this.errorStatus(`endpoint returned HTTP ${response.status}`);
      }
      return classifyQuota(await response.text(), now, this.plan.probe);
    } catch (error) {
      return this.errorStatus(error instanceof Error ? error.message : String(error));
    }
  }
  /**
   * One logical read.
   *
   * A single call is not one fact. The first readable verdict wins, because
   * a dropped request must never be the thing that decides the state.
   */
  async read(now) {
    let last = this.errorStatus("no attempt was made");
    for (let attempt = 0; attempt < this.config.readAttempts; attempt++) {
      last = await this.readOnce(now);
      if (last.error === null) return last;
    }
    return last;
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
  async tick() {
    const now = Date.now();
    const next = await this.read(now);
    if (next.error !== null) {
      this.errorStreak++;
      return nextDelay(next, true, now, this.plan.schedule, this.errorStreak, Math.random());
    }
    this.errorStreak = 0;
    const previous = this.latest;
    this.latest = next;
    const blocked = !isUsable(next, this.plan.probe.entry, this.plan.derive);
    if (this.wasBlocked && !blocked) this.onReset(next, previous);
    this.wasBlocked = blocked;
    this.ctx.emit("quota/changed", { status: next });
    return nextDelay(next, !blocked, now, this.plan.schedule, 0, Math.random());
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
  onReset(recovered, previous) {
    const window = previous?.rows.find(
      (row) => row.blocked && !recovered.rows.some((r) => r.window === row.window && r.blocked)
    )?.window;
    if (window === void 0) return;
    for (const agent of this.ctx.agents.list()) {
      if (agent.options.provider !== this.config.provider) continue;
      if (agent.status !== "idle") continue;
      const model = agent.options.model ?? "";
      if (!isUsable(recovered, model, this.plan.derive)) continue;
      agent.followup(
        createQuotaNotice(
          noticeText({
            provider: this.config.provider,
            model,
            spec: this.plan.derive,
            status: recovered,
            window
          }),
          `${this.config.provider} usage window reset \u2014 blocked work may resume`
        )
      );
    }
  }
  /** One self-rescheduling timer, owned by a single effect. */
  armTimer() {
    let stopped = false;
    let timer;
    const arm = (delayMs) => {
      if (stopped) return;
      timer = setTimeout(() => {
        void this.tick().then(
          (schedule) => arm(schedule.delayMs),
          () => arm(this.plan.schedule.maxIntervalMs)
        );
      }, delayMs);
      timer.unref?.();
    };
    void this.tick().then(
      (schedule) => arm(schedule.delayMs),
      () => arm(this.plan.schedule.maxIntervalMs)
    );
    return () => {
      stopped = true;
      if (timer !== void 0) clearTimeout(timer);
    };
  }
};
export {
  QuotaService as default
};
