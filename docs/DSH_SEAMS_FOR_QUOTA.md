# dsh seams relevant to quota awareness — a survey

> Background material, not a contract. The spec (`docs/superpowers/specs/2026-09-19-quota-awareness-design.md`) is binding; this doc explains **why** the spec landed where it did and **what other seams exist** that the next reader should know about before extending the package.

This is the cache that informs §10–§11 of the spec. Every claim cites the source that owns it. When this doc and an installed package disagree, the package wins — the project's first standard is "read seam contracts from the installed type definitions, never from memory or a cookbook."

## 0. The one rule, restated for this package

dsh-quota is **advisory, never a gate.** A `QuotaGate` that did gate traffic once existed in the sibling project `dsh-telegram` (added `d8cfda2`, deleted `5aa18f1`) and was removed deliberately. The "soft gate" the operator described — "below 10% a heavy sub-agent should use a different model" — is satisfied by **changing the route**, not by denying the call. The mechanisms below are listed in order of how much each one crosses that line.

## 1. Three pre-dispatch seams, compared

dsh has three waterfalls that fire before work leaves the agent. They differ in payload, in what they can change, and in whether a host row can use them without violating the project's doctrine.

| Seam | Mode | Fires | Payload | Decisions | Doc |
|---|---|---|---|---|---|
| `tools/pre-execute` | waterfall | every tool call (incl. `subagent`, `send_message`, `workflow`, …), after args are validated, before the body | `ToolExecution` — `name`, `arguments` (frozen), `agent`, `callId`, `signal` | `allow` / `deny` / `cancel` / `ask`. **No argument rewriting.** | [`docs/subsystems/tools.md:678`](https://github.com/deepseek-harness/deepseek-harness/blob/main/docs/subsystems/tools.md) |
| `agent/request` | waterfall | once per model step, after assembly, before the LLM call binds | `{ agent, turn, step, signal }` | return a replacement `LlmCallConfig` to switch `provider` / `model` / `reasoningEffort` / sampling for this request | [`docs/subsystems/core.md:957`](https://github.com/deepseek-harness/deepseek-harness/blob/main/docs/subsystems/core.md) |
| `agent/pre-step` | waterfall | before each step in a turn, with the messages about to enter the step | `{ agent, messages, turn, step, signal }` | rewrite or reject claimed messages; prepend context | [`docs/subsystems/core.md:922`](https://github.com/deepseek-harness/deepseek-harness/blob/main/docs/subsystems/core.md) |

The one this package already uses (via `ctx.sessionController.selectModel(...)`, §10 of the spec) is a different mechanism entirely — it is a service call that **durably** rewrites the deployment default and installs three scoped listeners (`system-prompt/assemble`, `agent/request`, `agent/pre-step`) on the agent's own context, not something the host subscribes to.

## 2. `tools/pre-execute` — the obvious-seeming seam, with three caveats

The `auto-review` package ([`packages/experimental/auto-review/src/index.ts:686`](https://github.com/deepseek-harness/deepseek-harness/blob/main/packages/experimental/auto-review/src/index.ts)) is the canonical host-row pattern: a `ctx.on('tools/pre-execute', async (exec, next) => { … })` listener that runs an LLM-based risk classifier on every tool call before letting it through. The same shape would let dsh-quota inspect every `subagent` call.

**Caveat 1 — arguments are frozen.** The registry deep-freezes `arguments` before `tools/pre-execute` runs, and the doc is explicit: *"Input rewriting is excluded because arguments are already logged and presented."* A pre-execute listener cannot rewrite `{ provider, model, reasoningEffort }` on the sub-agent tool call to point at the fallback. It can only `allow` / `deny` / `cancel` / `ask`.

**Caveat 2 — scope-filtered dispatch.** [`packages/core/scope/src/scoped-events.generated.ts:34`](https://github.com/deepseek-harness/deepseek-harness/blob/main/packages/core/scope/src/scoped-events.generated.ts) keys `tools/pre-execute` by `exec.agent`. A listener registered at the host (root) context sees every session in the runtime; one registered on `agent.ctx` sees only that agent's calls. The choice is per-listener.

**Caveat 3 — `deny` is a gate.** Returning `{ kind: 'deny', reason }` blocks the call. The spec forbids this. The morally cleaner uses of the seam are:

- *observe* — return `{ kind: 'allow' }` always; read `ctx.quota.get()` for diagnostics; do nothing else
- *steer* — return `{ kind: 'allow' }` and rely on the parent's already-switched route (Task 7) to do the work
- *defer* — return `{ kind: 'cancel' }` only when the call would do active harm (e.g. cascading into an unbounded retry); never on quota alone

A `tools/pre-execute` listener that denies a sub-agent call because the quota is low is the deleted `QuotaGate` in a different uniform.

## 3. `agent/request` — the seam that matches the operator's intent

The operator described: *"if quota is below 10%, a heavily tasked sub-agent should use a different model."* The right shape for that is **not** denying the call; it is changing the model the call will go out on. Two paths produce that effect:

1. **Durable route switch via `ctx.sessionController.selectModel(...)`.** Task 7 of the plan already does this on a confirmed block. The next turn the parent runs dispatches sub-agents whose `provider`/`model` arguments fall through to the parent's `request/header`, so the child inherits the new route without anyone denying anything.
2. **Per-step override via `agent/request` waterfall.** A host listener returns a replacement `LlmCallConfig` for that one step. This is per-call and bypasses the hysteresis guards; it is the wrong tool for a quota-driven policy.

The spec's §10 chose option (1) deliberately. This doc records option (2) so the next reader knows the seam exists and why it was rejected for this policy.

## 4. The wake-on-refresh seam (operator's second question)

The operator asked: *"of course, we can let the sub-agent deplete the quota, wait M minutes, then the main agent push the sub-agent to continue — does dsh have such way?"*

**Yes.** Three primitives compose into the answer; each is documented, none is built-in as a single feature.

### 4.1 `send_message` — the only way to talk to a continuable child

`@deepseek-ai/dsh-tool-subagent-control` registers two tools in the global scope:

- `send_message({ agent_id, message })` — delivers a message to a direct continuable child (or, when called from a child, to its direct parent). A working target receives at the next step; an idle target starts a new turn with it. Returns the accepted `messageId`, not the agent's answer.
- `interrupt_agent({ agent_id })` — synchronous interrupt authorization; does not wait for the target to stop. Unclaimed inbox work and descendants are preserved.

Source: [`packages/subagent/tool-subagent-control/lib/types/index.js:21-97`](https://github.com/deepseek-harness/deepseek-harness/blob/main/packages/subagent/tool-subagent-control/lib/types/index.js).

### 4.2 Continuable children are durable across activations

A continuable background sub-agent (started with `backgroundMode: 'continuable'`) is one durable child Session with at most one process-local **Activation**. The parent receives a `subagentId` at start time and can resume the same child later from cold if needed. One-shot children (`backgroundMode: 'one-shot'` or default) cannot be continued; `list_agents` reports them as `inactive` and `send_message` is not admitted against them.

Source: [`docs/subsystems/subagent.md:124-148`](https://github.com/deepseek-harness/deepseek-harness/blob/main/docs/subsystems/subagent.md).

### 4.3 Boundary-aware timer — what dsh-quota already has

dsh-quota's Task 4 arms exactly one timer at `windowEndsAt + jitter` (default 10 s ± 5 s). That is the same primitive the wake-on-refresh flow needs — a host-side timer that fires once at a known instant, owned by a `ctx.effect`. The timer does not need a model in the loop; it can call `ctx.subagents.sendMessage(...)` from host code.

### 4.4 The composed loop

```
parent ──startContinuable──> subagent (idle, parked)
  │
  │ quota < threshold, route-policy row switches parent route to fallback
  │ parent settles, calls interrupt_agent (optional)
  │
  │ dsh-quota boundary timer fires at windowEndsAt + jitter
  ▼
host row: ctx.subagents.sendMessage(parentAgent, childId,
                                     [{type:'text', text:'quota refreshed — you may continue'}],
                                     { signal: rowSignal })
  │
  ▼
subagent (cold-resumed if needed, wakes, continues on fallback route)
```

### 4.5 Three constraints from the source, easy to get wrong

| Issue | Source | What it means in practice |
|---|---|---|
| `send_message` requires a **live sender**, not a session id | [`docs/subsystems/subagent.md:138-150`](https://github.com/deepseek-harness/deepseek-harness/blob/main/docs/subsystems/subagent.md) | A host timer cannot invent a parent — it must walk `ctx.agents.list()`, find the parent whose `agent.id` matches the recorded parent session, and use *that* `Agent` object as the first arg. |
| A timer firing from a host row needs a live parent | same | If the parent is itself settled/cold when the timer fires, `sendMessage` rejects. Cold-resume belongs to the **child** (which has a session log), not to the parent. |
| Continuable requires provider support | [`packages/subagent/tool-subagent/src/index.ts:613-680`](https://github.com/deepseek-harness/deepseek-harness/blob/main/packages/subagent/tool-subagent/src/index.ts) | The chosen provider must declare `prepareContinuable`. Spawn and fork in-process providers do; ACP, Codex, Claude Code, DSH-SDK do **not**. |

### 4.6 Why the light answer (no wake-on-refresh) matches the doctrine

The smaller version of this loop is:

- Task 7 already switches the parent's route on confirmed block.
- Task 7 already restores the parent's remembered route on confirmed refresh.
- After restore, the parent itself is on the original route and is free to dispatch a new turn. If the sub-agent is still parked, the parent's next turn can call `send_message` to wake it — the *model* decides when, not a host timer.

This is "advisory, never a gate." The wake-on-refresh host-timer variant crosses one more line: the timer is the policy *and* the policy decides when the child runs. The seam is there, and a future task can ship it (see plan §8a), but the default should remain the light answer.

## 5. What the spec actually says, in one place

| Question | Spec section | What it does |
|---|---|---|
| How does the route get switched? | §10 | `ctx.sessionController.selectModel({ sessionId, provider, model, reasoningEffort })` durably rewrites the route, installs three scoped listeners, and emits a `modelSwitchNotice` so the user sees the change. |
| What guards the route switch against flapping? | §10 | `confirmations` (default 2 consecutive readings in the new state), `minSwitchIntervalSeconds` (default 300 s between switches for the same session), warning-only readings do not switch, rejected routes are logged and not retried until the next transition. |
| Can the agent switch routes by judgement? | §11 | `select_model(status?, list?, provider?, model?, reasoningEffort?, sessionId?)` — registered by a separate row, useful with no quota concept. |
| Why not just gate the sub-agent call? | §1 (Non-goals) | Explicit. The deleted `dsh-telegram` `QuotaGate` (`d8cfda2` → `5aa18f1`) tried exactly that and was removed. The "soft gate" the operator described is a route change, not a denial. |

## 6. Open questions deferred by this doc

These are deliberately not answered; they belong to a future task.

- **What if the throttled provider is the only one for the agent's purpose?** The `select_model` tool's `list` mode already exposes the catalog; the route-policy row can refuse to switch if `ctx.llm.resolveCallConfig(...)` fails. Spec §10 records this as "never switch to a fallback that fails `resolveCallConfig`."
- **Should `tools/pre-execute` observe quota for diagnostics?** A passive listener that logs but never denies is allowed by the doctrine and may be useful for a future client UI. Deferred; not in the plan.
- **Wake-on-refresh as a Task 8a?** See the plan's Task 8a for the seam-by-seam sketch and the trade-offs.
