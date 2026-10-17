# Quota Reset Service — Design Spec

**Status:** binding for `feat/quota-groundup`. Increments 1–3 are implemented and verified; increments 4–5 are specified here and planned in `../plans/2026-10-17-quota-reset-service.md`.

**Supersedes nothing.** `docs/superpowers/specs/2026-09-19-quota-awareness-design.md` describes a different, three-row architecture implemented on `feat/quota-impl`. It remains valid for that branch. This spec is ground-up and single-row; where the two disagree, this one governs this branch.

---

## 1. Goal

Watch one LLM provider's rolling usage windows and give an agent three things:

1. **Awareness** — the current usage state as part of its system prompt.
2. **Inquiry** — a tool it can call to read the same state on demand.
3. **A wake-up** — when a window that blocked it resets, one system message announcing the reset, sent into the session.

The wake-up exists because a session whose turn died on a quota refusal has no way back: the turn errored, the agent is idle, and nothing will prompt it to try again. A blocked agent stays blocked until a human intervenes, even after the limit is gone.

## 2. Non-goals

- **Not a gate.** It never blocks, denies, queues, parks or rewrites a request. At most it *adds* one user-role message, after a reset. A session that ignores it entirely is unaffected.
- **Not a router.** It does not switch models. A reset says the route works again, not which route should be used.
- **Not a poller.** The provider reports the countdown to the window boundary, so the reset time is *known*. The timer schedules; the probe verifies.
- **Not multi-provider, yet.** One plan per row. §9 says what deferring costs.

## 3. The provider's rules, and what they force

Usage resets over two independent windows. A 5-hour window gates non-video models; a weekly window gates everything including video. They reset independently, neither carries the other, and unused usage does not accumulate.

Three consequences shape the data model:

- **`usable` is a property of `(rows, model)`, never of the plan.** A video model is unaffected by an exhausted 5-hour window. This is why `PlanStatus` has no `usable` field: two sources of truth for "can I run?" is a bug waiting to happen.
- **A blocked window says nothing about the other.** Detect a block on the window that is actually blocked. The 5-hour interval can read 0% while weekly reads 100%.
- **An unread row is not a blocked row.** Only a confirmed row denies a request. Absence is resolved toward permission, because the provider reports weekly headroom separately and it can read healthy while the interval is exhausted.

## 4. Architecture

Four increments. Each adds an independently testable deliverable.

| # | Deliverable | Shape |
|---|---|---|
| 1 | Pure core | `probe` (narrow), `derive` (policy), `schedule` (timer), `block` (classify). No dsh import, no fiber, no clock, no network. |
| 2 | Rendering | `format` (prompt line), `notice` (announcement text + summary). Still pure. |
| 3 | Service | `config`, `state` (the edge as a pure reducer), `index` (the row). |
| 4 | Subscription | `subscription` (pure reconcile), `tool`; wired into the row. |
| 5 | Composition | build assertion, patch row, harness mount case. |

**The split is load-bearing.** Everything that can be decided without I/O lives in a pure function, so the state machine, the schedule and the parser are testable with a string and a number. Nothing in increments 1–2 or the `state`/`derive`/`schedule` parts of 3 touches Cordis.

## 5. The edge, not the level

The announcement fires on `unusable → usable` for a specific blocked record — **once** — and never on a healthy reading.

This is the single most important rule. A watcher armed while quota is healthy would otherwise match immediately, spend its single fire, and never fire for the real reset. The marker turns a level into an edge.

Three refinements, each forced by a failing test:

- **Per record, not per account.** Two sessions can be gated by different windows — a video session on the weekly window, a text session on the 5-hour one. The edge is evaluated per blocked record, so each is woken by its own reset.
- **A failed read must not overwrite the last good status.** It bumps an error streak and changes nothing else. Overwriting erases the fact that a session was blocked, so one dropped request in the middle of an exhaustion window silently swallows the reset that follows.
- **The window comes from the record, not the status.** By the time the message is delivered everything reads healthy. Only the record captured at failure time knows which window expired.

## 6. Block classification

Three sources, in decreasing order of stability:

1. **A harness-assigned code**, matched exactly: `QUOTA`, `ACCOUNT_QUOTA` (`HARNESS_QUOTA_CODES`).
2. **Configured patterns** over `code`, `status` and `message` — the net for providers the adapter did not classify.

Source 1 exists because the adapter normalizes before we see it. `dsh-llm-pi-ai` runs `classifyPiAiError(message)` and maps provider wording through `isQuotaExceededError`, so MiniMax's raw `2056 usage limit exceeded` arrives as `code: 'QUOTA'`. The raw vendor number is only ever in the message. **Matching prose alone would have been matching the fragile signal.**

A record is a *candidate*. The probe is the authority: a record only produces an announcement on a confirmed `unusable → usable` transition. So a false-positive classification costs nothing, while a false negative strands a session — the asymmetry that sets the default patterns.

## 7. Two failure channels

Both are observed, because one is not enough:

- **`agent/request-error`** — an *in-band* stream refusal. The only channel carrying a structured `failure` and the provider. In the installed loop it is guarded by `if (finish.kind === 'error' || 'aborted')`.
- **`agent/error`** — a *thrown* transport or protocol failure. It jumps past that guard, becomes `turn/end {kind:'error'}`, and its payload carries `error: unknown` with no `failure` field.

A dropped connection is precisely the shape that strands a session. The `unknown` is narrowed by explicit checks, never a cast.

## 8. Subscription is derived, not stored

A session is subscribed iff its committed route is this row's provider. That is a *derived value*, recomputed on route change — not a flag set once at `agent/created`.

Two triggers, one idempotent reducer:

- **`model/selection`** — user intent, appended by the selection funnel (the Web UI picker *and* the `select_model` tool both go through `sessionController.selectForNextRequest`). Fires early, so the first assembly after a switch is already correct. **Not universal** — CLI and preset paths may not append it.
- **`request/context`** — committed by the loop before dispatch. **Authoritative and universal**, but it lands *after* prompt assembly for that step, so on its own it would leave the first turn after a switch without the quota surface.

Ruling: the prompt line does **not** read `selection.current` from `dsh-api-session-controller`. That would resolve the route perfectly, at assembly time — but it makes the row depend on an optional, gateway-specific service for its core behaviour. Two triggers on the universal event stream cost two registrations that no prompt ever observes, and that is the cheaper failure.

Detaching drops the session's block record. The failure was real, but announcing a reset for work the session has since moved past is noise; re-blocking creates a fresh record.

## 9. Deferring multi-provider

One plan per row. The deferral is additive, not a rewrite: `PlanDefinition` becomes `Map<PlanId, PlanRuntime>`, `nextDelay` and `settle` are already per-plan pure functions, and the route index is a `Map<LlmCallConfig.provider, PlanId>`. Two configs a deployment cannot get wrong silently: two plans claiming the same route must throw at load, and a route no plan claims must log a warning naming it.

## 10. Standing constraints

- **Seam contracts are read from the installed type definitions**, never from memory or a cookbook. Every version claim in a comment cites `0.1.7-rc.2`.
- **Prove tests can fail.** Every task names a mutation, applies it, asserts the suite goes red, and reverts byte-identically. `scripts/mutate.mjs` runs the whole set and exits non-zero if any survives.
- **Never assert a shape on external data.** The endpoint is untrusted: narrow with explicit checks, never `as`.
- **A `catch` that is load-bearing must report.** A silent swallow already hid a `require` that does not exist in ESM, leaving the row looking healthy while writing nothing.
- **Typecheck before commit, not alongside tests.** Two commits went in with a red `tsc` because tests were green and `tsc` was not run.
- **Runtime dsh imports: `@deepseek-ai/cordis` and `@deepseek-ai/dsh-tools`.** Both are forced — `extends Service` is a real base class, and `defineTool` compiles the parameter DSL. Everything else is `import type`. `@deepseek-ai/dsh-llm` is **test-only**: `tests/unit/message.test.ts` uses `createUserMessage` as an oracle for the hand-rolled announcement literal.

## 11. Known gaps

- `src/index.ts` has no test. A mutation deleting the `agent/error` listener would survive today. Increment 5's harness case closes this by emitting synthetic events through a mounted fiber.
- The weekly window's field path is unconfirmed. `derive.ts` treats an absent weekly row as "not blocked" — the safe direction — and adding it is one new row in `classifyQuota`.
- `matchesBlock` gates records on the row's provider, but `agent/error` carries no provider, so that channel trusts `agent.options`. A session whose *effective* route differs from its options could be recorded against the wrong plan. Increment 5's harness case should exercise it.
