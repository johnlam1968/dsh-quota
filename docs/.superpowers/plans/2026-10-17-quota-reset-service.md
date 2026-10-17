# Quota Reset Service — Implementation Plan (increments 4–5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the ground-up `dsh-quota` row — give a subscribed session a prompt line and a `quota_status` tool, reconcile that subscription on route change, then ship the composition and prove it mounts.

**Architecture:** A single host-plane Cordis `Service` (`ctx.quota`) that probes one provider's rolling windows on a self-rescheduling timer and wakes sessions whose turn died on a quota refusal. Every decision that does not need I/O is a pure function; the row is wiring plus I/O. Subscription is derived from the session's committed route, recomputed on `model/selection` and `request/context`, never stored as a flag.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), Node 25 ESM, vitest 2, `@deepseek-ai/cordis` 4.0.4, `@deepseek-ai/dsh-tools` 0.1.7-rc.2, `@deepseek-ai/dsh-llm` 0.1.7-rc.2 (test-only oracle), `@deepseek-ai/schemastery` 3.18.4.

**Spec:** `docs/.superpowers/specs/2026-10-17-quota-reset-service.md`

## Global Constraints

- **Seam contracts are read from the installed type definitions.** Every runtime claim cites dsh `0.1.7-rc.2`. Do not infer a shape from a cookbook.
- **Prove tests can fail.** Each task names its mutations, adds them to `scripts/mutate.mjs`, and reports the kill count. A surviving mutation fails the task.
- **Never assert a shape on external data.** Explicit checks only, never `as`.
- **A `catch` that is load-bearing must report.**
- **Typecheck before commit.** `pnpm typecheck && pnpm test` must both be green *before* `git commit`, never after.
- **Runtime dsh imports: `@deepseek-ai/cordis` and `@deepseek-ai/dsh-tools` only.** The build assertion in Task 7 is an allowlist of exactly those two.
- Conventional commits.

## File Structure

| File | Responsibility | Status |
|---|---|---|
| `src/types.ts` | `WindowRow`, `PlanStatus`, `BlockRecord` | done |
| `src/probe.ts` | Narrow one untrusted response into rows | done |
| `src/derive.ts` | Rows + model → `usable`; window precedence; video exemption | done |
| `src/schedule.ts` | Status → when to probe again | done |
| `src/block.ts` | Failure → is this the quota block | done |
| `src/format.ts` | Status → one prompt line, or `''` | done |
| `src/notice.ts` | Block record + status → announcement text and summary | done |
| `src/message.ts` | Build the frozen `UserMessage` without a runtime dsh-llm import | done |
| `src/config.ts` | Schemastery `Config`, `QuotaConfig`, `definePlan` | done |
| `src/state.ts` | The reset edge as a pure reducer | done |
| `src/index.ts` | The row: timer, probes, both failure channels, delivery | done |
| `src/subscription.ts` | Pure reconcile reducer + the attach/detach bundle | **Task 4** |
| `src/tool.ts` | `defineTool('quota_status')` | **Task 5** |
| `src/index.ts` | + subscription wiring | **Task 6** |
| `scripts/build.mjs` | esbuild + the runtime-import allowlist assertion | **Task 7** |
| `cordis.patch.yml` | The composition row | **Task 8** |
| `tests/support/partial.ts` | The one named cast for schemastery "input typed as output" | **done** |
| `tests/harness/root.ts` | The single real `Context` assembly for tests | **done** |
| `tests/harness/mount.test.ts` | Lifecycle gate: mount / inert / re-apply / dispose / ownership | **done** |
| `tests/contract/*.test.ts` | The row driven through real Cordis events | **Task 9** |

## Test tiers

Adopted from `feat/quota-impl`'s suite, which is further along and better factored than this plan was.

| Tier | Mounts | Drives | Proves |
|---|---|---|---|
| `unit/` | nothing | pure functions | behaviour of a decision |
| `contract/` | a real `Context` | `ctx.emit(...)`, stubbed globals | that the wiring calls the behaviour |
| `harness/` | a real `Context` | lifecycle only | that the row mounts, updates, disposes, owns its effects |

Two rules from it that this plan had wrong:

- **The gate is not a late task.** `feat/quota-impl` runs its mount gate "from Task 1 onward", because two P0 defects there were lifecycle defects a plain-object `ctx` mock cannot see. This plan had it last; it is now written and shipped (Tasks 0 below).
- **No case calls a handler directly.** Every contract case goes through `ctx.emit`, because calling a handler directly "would prove the handler body and nothing about whether anything calls it". That is precisely the discipline `src/index.ts` currently lacks.

---

### Task 0: The lifecycle gate — DONE, shipped in `f74aec6`

Written and passing before any further work, because it is the precondition for
trusting every later tier. See `tests/harness/root.ts` and
`tests/harness/mount.test.ts`. Two things it caught immediately:

- `Context.plugin()` does **not** take `exports.default ?? exports`. A namespace
  import of a Service class hands it an object with no `apply` and it refuses
  to mount. The Loader's `??` is a *Loader* convenience, not Cordis'.
- `fiber.update()` is typed `void` and restarts behind the async
  `internal/update` waterfall, so `await fiber.update(...)` awaits `undefined`
  and reads the fiber mid-`UNLOADING`. The gate polls for the settled state and
  then asserts it, so a stuck fiber fails rather than passing quietly.

---

### Task 4: The reconcile reducer

Pure. No dsh import, no `ctx`. A subscription decision is a function of `(current binding, incoming provider+model)`, so it is testable as a table.

**Files:**
- Create: `src/subscription.ts`, `tests/unit/subscription.test.ts`

**Interfaces:**
- Consumes: `PlanId` (plain `string` here), `SessionId` (type-only from `@deepseek-ai/dsh-session`)
- Produces: `Binding`, `SubscriptionState`, `SubscriptionPlan`, `decideBinding(current, incoming, provider)`, `attach()`, `detach()`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/subscription.test.ts
import { describe, expect, it } from 'vitest'
import { decideBinding } from '../../src/subscription.js'

const PROVIDER = 'minimax-cn'

describe('decideBinding', () => {
  // MUTATION: return an attach decision for an unplanned provider.
  it('leaves a session alone when the route is not this row', () => {
    expect(decideBinding({ provider: PROVIDER, model: 'm1' }, { provider: 'deepseek-official', model: 'm2' }, PROVIDER))
      .toEqual({ action: 'detach' })
  })

  // MUTATION: compare only the provider and ignore the model.
  it('stays attached across a model change within the same plan', () => {
    expect(decideBinding({ provider: PROVIDER, model: 'm1' }, { provider: PROVIDER, model: 'm2' }, PROVIDER))
      // A model change within one plan still re-renders the line, but must not
      // re-register the tool.
      .toEqual({ action: 'stay', model: 'm2' })
  })

  // MUTATION: re-attach on every reconcile.
  it('attaches a session that arrives on this row', () => {
    expect(decideBinding(null, { provider: PROVIDER, model: 'm1' }, PROVIDER))
      // The decision must carry the model: the caller builds the prompt line
      // and the tool's report from it, so `attach` without one is unusable.
      .toEqual({ action: 'attach', model: 'm1' })
  })

  // MUTATION: compare models as a set difference.
  it('re-attaches when the plan changes away and back', () => {
    expect(decideBinding({ provider: PROVIDER, model: 'm1' }, { provider: PROVIDER, model: 'm1' }, PROVIDER))
      .toEqual({ action: 'stay', model: 'm1' })
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm exec vitest run tests/unit/subscription.test.ts`
Expected: FAIL — `Cannot find module '../../src/subscription.js'`.

- [ ] **Step 3: Write the minimal implementation**

```ts
// src/subscription.ts
/** Which plan a session is currently bound to, if any. */
export interface Binding {
  readonly provider: string
  readonly model: string
}

export type SubscriptionDecision =
  | { readonly action: 'attach'; readonly model: string }
  | { readonly action: 'detach' }
  /** `model: null` means "unbound, and still unbound" — nothing to render. */
  | { readonly action: 'stay'; readonly model: string | null }

export function decideBinding(
  current: Binding | null,
  incoming: Binding | null,
  provider: string,
): SubscriptionDecision {
  const wanted = incoming !== null && incoming.provider === provider ? incoming : null
  if (wanted === null) {
    return current === null ? { action: 'stay', model: null } : { action: 'detach' }
  }
  if (current !== null && current.model === wanted.model) return { action: 'stay', model: wanted.model }
  return { action: 'attach', model: wanted.model }
}
```

> A model change within the same plan must NOT re-register: the model picker can cycle a model dozens of times and each re-registration churns the prompt assembly for nothing. `stay` carries the current model so the caller knows which model the bundle was built for.

- [ ] **Step 4: Run it and confirm it passes**

Run: `pnpm exec vitest run tests/unit/subscription.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Add the two mutations and prove they die**

Add to `scripts/mutate.mjs`:

```js
  {
    file: 'src/subscription.ts',
    test: 'tests/unit/subscription.test.ts',
    find: "  const wanted = incoming !== null && incoming.provider === provider ? incoming : null",
    replace: '  const wanted = incoming',
    claim: 'an unplanned provider leaves the session alone',
  },
  {
    file: 'src/subscription.ts',
    test: 'tests/unit/subscription.test.ts',
    find: "  if (current.provider === wanted.provider && current.model === wanted.model) return { action: 'stay', model: wanted.model }",
    replace: "  if (false) return { action: 'stay', model: wanted.model }",
    claim: 'a model change within one plan does not re-register',
  },
```

Run: `node scripts/mutate.mjs`
Expected: `26/26 mutations killed`.

- [ ] **Step 6: Commit**

```bash
pnpm typecheck && pnpm exec vitest run tests/unit/subscription.test.ts
git add src/subscription.ts tests/unit/subscription.test.ts scripts/mutate.mjs
git commit -m "feat(subscription): pure reconcile reducer

Subscription is derived from the committed route, not stored as a flag set
once at agent/created. decideBinding is a pure function of (current binding,
incoming provider+model) so the whole decision table is testable without a
fiber, a session, or a clock."
```

---

### Task 5: The `quota_status` tool

**Files:**
- Create: `src/tool.ts`, `tests/unit/tool.test.ts`

**Interfaces:**
- Consumes: `PlanStatus | null`, `deriveUsable`, `effectiveRows`, `formatDuration`
- Produces: `buildStatusTool(deps: { provider: string; status: () => PlanStatus | null; derive: DeriveSpec; lowWaterMarkPercent: number }): ToolDefinition`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/tool.test.ts
import { describe, expect, it } from 'vitest'
import { statusPayload } from '../../src/tool.js'

const spec = { entry: 'general', videoModelPatterns: [] as RegExp[] }
const status = {
  provider: 'minimax-cn', checkedAt: 1_700_000_000_000, error: null,
  rows: [{ entry: 'general', window: '5h' as const, blocked: true, remainingPercent: 0, resetAt: 1_700_000_000_000 + 90_000 }],
}

describe('statusPayload', () => {
  // MUTATION: report a fixed `usable: true`.
  it('reports the same usable verdict the prompt line uses', () => {
    expect(statusPayload(status, 'm1', spec).usable).toBe(false)
  })

  // MUTATION: omit the reset countdown.
  it('reports each gating window with its countdown', () => {
    expect(statusPayload(status, 'm1', spec).windows).toEqual([
      { window: '5h', blocked: true, remainingPercent: 0, resetsInMs: 90_000 },
    ])
  })

  // MUTATION: report a block when the plan has never been read.
  it('reports an unread plan as unknown rather than blocked', () => {
    const payload = statusPayload(null, 'm1', spec)
    expect(payload.usable).toBe(true)
    expect(payload.known).toBe(false)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm exec vitest run tests/unit/tool.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the payload and the tool**

```ts
// src/tool.ts
import { defineTool } from '@deepseek-ai/dsh-tools'
import { effectiveRows, isUsable } from './derive.js'
import type { DeriveSpec } from './derive.js'
import { formatDuration } from './format.js'
import type { PlanStatus } from './types.js'

export interface StatusPayload {
  readonly known: boolean
  readonly provider: string
  readonly usable: boolean
  readonly windows: readonly { window: string; blocked: boolean; remainingPercent: number | null; resetsInMs: number | null }[]
}

/** The one derivation the tool and the prompt line share. */
export function statusPayload(status: PlanStatus | null, model: string, spec: DeriveSpec): StatusPayload {
  if (status === null || status.error !== null) {
    return { known: false, provider: status?.provider ?? '', usable: true, windows: [] }
  }
  return {
    known: true,
    provider: status.provider,
    usable: isUsable(status, model, spec),
    windows: effectiveRows(status.rows, model, spec).map(row => ({
      window: row.window,
      blocked: row.blocked,
      remainingPercent: row.remainingPercent,
      resetsInMs: row.resetAt === null ? null : Math.max(0, row.resetAt - status.checkedAt),
    })),
  }
}
```

**Ruling R2 — do not guess this body.** The writing-plans skill treats an elided
step as a plan failure, and it is right here: the parameter DSL is dsh's own,
not JSON Schema, and `ctx.tools.register` re-validates the definition at
registration. Before writing it, read `@deepseek-ai/dsh-tools` README section
"Register a tool" and the `ToolDefinition` declaration for the installed version.

Register it with `defineTool`, whose `description` is the model's only guide to *when* to call it. The instruction that matters is the one that prevents the halt:

> `'… Call this before concluding that a provider is unavailable: a usage limit is temporary and announces its own reset.'`

- [ ] **Step 4: Run, confirm pass, add mutations, commit**

Add to `scripts/mutate.mjs`: `statusPayload` returning a fixed `usable: true`, and one omitting `resetsInMs`. Expect `28/28 killed`.

```bash
pnpm typecheck && pnpm exec vitest run tests/unit/tool.test.ts
git commit -m "feat(tool): quota_status reporting the same verdict as the prompt line

The tool and the prompt line must never disagree about whether a request
would be accepted, so both go through isUsable rather than each caching a
verdict of its own."
```

---

### Task 6: Wire subscription into the row

**Files:**
- Modify: `src/index.ts` (constructor + two listeners + `attachSubscription`/`detachSubscription`)

- [ ] **Step 1: Add the listeners to the constructor**

```ts
    this.ctx.on('agent/created', ({ agent, source }) => {
      // A resumed session may have been blocked before the host restarted.
      // Its durable log is the only place that still knows.
      if (source === 'resume') this.sweepHistory(agent)
      agent.ctx.on('session/event', (_session, event) => {
        // Intent: appended by the selection funnel (picker and select_model
        // both go through it) BEFORE the next turn, so the first assembly
        // after a switch is already correct.
        if (event.type === 'model/selection') this.reconcile(agent, { provider: event.data.provider, model: event.data.model })
        // Commitment: written by the loop before dispatch, on every path.
        if (event.type === 'request/context') this.reconcile(agent, { provider: event.data.provider, model: event.data.model })
      })
    })
```

- [ ] **Step 2: Implement `reconcile`, `attachSubscription`, `detachSubscription`**

`reconcile` calls `decideBinding`, and on `attach` registers `agent.ctx.systemPrompt.context({ name: 'quota-usage-status', order: 900, required: true, text: () => renderQuotaStatus(...) })` plus `agent.ctx.tools.register(buildStatusTool(...))`, storing both disposers. On `detach` it disposes them **and** calls `this.forget(agent.id)`.

`required: true` is load-bearing: it keeps the context when `suppressRuntimeContext()` is active, because a blocked agent must never be able to suppress the fact that it is blocked.

- [ ] **Step 3: Implement `sweepHistory`**

On `source === 'resume'`, walk `agent.session.ownEvents()` for a trailing `turn/end` with `reason.kind === 'error'`, narrow `reason.error` to a `FailureLike`, and if `matchesBlock` accepts it, `this.state = withBlock(this.state, agent.id, …)`.

- [ ] **Step 4: Harness test for both channels — deferred to Task 9**

Do **not** claim this task is covered by the unit suite. It is not: a mutation deleting either listener survives today. Say so in the commit body.

```bash
pnpm typecheck && pnpm test
git commit -m "feat(subscription): reconcile on model/selection and request/context

... Records explicitly that no test covers this wiring yet."
```

---

### Task 7: Build with an import allowlist

**Files:** Create `scripts/build.mjs`, `tsconfig.build.json`

- [ ] **Step 1: Write the build script**

Bundle `src/index.ts` with the esbuild JS API, then walk the metafile inputs for `@deepseek-ai/*` specifiers and assert the set is a **subset of** `{@deepseek-ai/cordis, @deepseek-ai/dsh-tools}`. Throw listing anything else. An allowlist, never a blanket ban, so a new legitimate dependency is a deliberate edit.

- [ ] **Step 2: Run it**

```bash
pnpm build
```
Expected: bundle emitted, assertion passes, `tsc -p tsconfig.build.json` emits declarations.

---

### Task 8: The composition row

**Files:** Create `cordis.patch.yml`

- [ ] **Step 1: Write the patch**

```yaml
- id: dsh-quota
  name: dsh-quota
  config:
    provider: minimax-cn
    entry: general
    endpoint: https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains
    authEnv: MINIMAX_API_KEY
    blockPatterns: ['usage limit exceeded', '\b2056\b']
    lowWaterMarkPercent: 20
```

- [ ] **Step 2: Verify it composes**

Run: `dsh --profile web --dump-config` and confirm a `# == dsh-quota` layer marker.

---

### Task 9: The contract tier

**Split by ruling R3.** **9a** (below) runs FIRST, before Tasks 4–6: it tests
shipped code and has no dependency on them. **9b** is the subscription half and
runs after Task 6.

**Files:** Create `tests/contract/wake.test.ts`, `tests/contract/support.ts`

The gate is done; this is the tier that closes the wiring gap in `src/index.ts`.
No case may call a handler directly — every one goes through `ctx.emit` on a
real `Context`, which is the only thing that proves something *calls* it.

- [ ] **Step 1: A scripted endpoint, shared**

Reuse the pattern: "answer with each read in turn; the last one repeats;
`undefined` = unreadable", via `vi.stubGlobal('fetch', …)` plus
`vi.useFakeTimers()`. Globals rather than injected seams, deliberately — an
injected clock or fetch handle is a knob that can be wired wrong.

- [ ] **Step 2: The two failure channels, through real events**

Emit a synthetic `agent/request-error` and a synthetic `agent/error` and assert
each records a block. **This is what makes a mutation deleting the
`agent/error` listener die** — `find` is the whole `this.ctx.on('agent/error', …)`
block, `replace` is empty.

- [ ] **Step 3: Assert the waterfall is delegated**

`agent/request-error` is a waterfall. Assert `next` was called, so the failure
stays retryable. The row is advisory; a listener that swallows `next` would
silently make every quota refusal terminal.

- [ ] **Step 4: Assert on non-actions, not just outcomes**

`expect(vi.getTimerCount()).toBe(0)` — not merely "did not wake", but "did not
arm". And advance to `resetMs - 1` for "no wake before the window rolls", then
`resetMs` for exactly one.

- [ ] **Step 5: Route filtering on `agent/error`**

That payload has no `provider`, so the row trusts `agent.options`. Assert a
failure from another provider is ignored, and that the check is the agent's own
route.

- [ ] **Step 6: Run the full proof**

```bash
pnpm typecheck && pnpm test && node scripts/mutate.mjs
```
Expected: every mutation killed, including the two new ones from steps 2 and 3.

---

## Self-Review

**Spec coverage.** §5 edge → Tasks 1/3, verified. §6 classification → Task 3, verified. §7 two channels → Task 6, tested Task 9. §8 subscription → Tasks 4–6. §9 multi-provider → out of scope by the user's instruction, recorded in spec §9. §10 constraints → Global Constraints. §11 gaps → Task 9 closes the channel gap and the `agent.options` trust; the weekly field path is correctly a one-row change with no task.

**Placeholder scan.** No TBD, no "similar to Task N". Task 5's `defineTool` body is elided; it is mechanical given `statusPayload`, `render`, and `output.schema` above it, and the implementer has the README section to hand. Flag it rather than let it be guessed wrong.

**Type consistency.** `Binding`, `SubscriptionDecision`, `decideBinding`, `StatusPayload`, `statusPayload`, `buildStatusTool`, `renderQuotaStatus`, `withBlock`, `forget` — each is introduced once and referenced by the exact name later.
