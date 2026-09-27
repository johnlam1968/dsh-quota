# dsh-quota Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A host-plane dsh bundle that watches a model provider's rolling window quota and lets both an agent (by judgement) and a configured policy (automatically) change a session's model route in flight.

**Architecture:** Three rows in one package. The observation row publishes `ctx.quota` (a `Service`), emits `quota/changed`, and registers a `quota_status` tool; it arms exactly one timer at the provider's own window boundary rather than polling. A second row registers a `select_model` tool so an agent can inspect or change a route by judgement. A third, independently disableable row consumes `quota/changed` and switches affected sessions to a fallback route on a confirmed block, restoring each session's remembered route on a confirmed refresh.

**Tech Stack:** TypeScript, Node 25 (ESM), esbuild (host bundle), `tsc` (declarations only), vitest, `@deepseek-ai/schemastery` (row config), zod (nothing here — no storage domain), `@deepseek-ai/cordis` 4.0.2 (dev, types + the mount harness).

**Spec:** `docs/superpowers/specs/2026-09-19-quota-awareness-design.md`

## Global Constraints

- **Worktree first.** Create one with the `using-git-worktrees` skill before Task 1; never implement on `master`.
- **Pin the versions the profile resolves.** Dev-only (types + harness): `@deepseek-ai/cordis@4.0.2`, `@deepseek-ai/dsh-api-session-controller@0.1.5-rc.2`, `@deepseek-ai/dsh-agent@0.1.5-rc.2`, `@deepseek-ai/dsh-tools@0.1.5-rc.2`, `@deepseek-ai/dsh-llm@0.1.5-rc.2`, `@deepseek-ai/dsh-session@0.1.5-rc.2`, plus `@types/node@^22.20.0` (the harness's own pin), `esbuild`, `typescript`, `vitest`. npm `latest` for the dsh packages is `0.0.1-rc.1` — never install unpinned.
- **Runtime dsh imports: `@deepseek-ai/dsh-tools` only.** Every other dsh/cordis import is `import type`; the emitted bundle must import nothing else from `@deepseek-ai/*` except `schemastery`. See AGENTS.md for why the tool registration path forces this one exception, and keep the build assertion an **allowlist of one** rather than deleting it.
- **`lib/` is tracked.** Every task that changes `src/` runs `pnpm build` and commits the regenerated `lib/` in the same commit.
- **Seam contracts come from the installed type definitions, never from memory or a cookbook.** This rule exists because four plan defects in the sibling project were caught this way and two were not.
- **Prove tests can fail.** Every task names at least one mutation that must make a test fail; revert it byte-identically and report both results. A test that survives its own behaviour being deleted is worse than no test.
- **Never assert a shape on external data.** The quota endpoint is untrusted input: narrow it with explicit checks, never `as` casts.
- **One harness case per seam the plugin registers into**, passing a fake through the harness root's `extra` argument.
- Conventional commits; tests must pass before every commit.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/index.ts` | The observation row: `name`, `inject`, `Config`, `apply`; publishes the service, emits the event, registers `quota_status` |
| `src/config.ts` | `QuotaConfig` + the schemastery `Config`, single source of defaults |
| `src/quota/parse.ts` | Pure: pick a bucket from `model_remains[]`, derive `usable`, build a `QuotaSnapshot` |
| `src/quota/fetch.ts` | One HTTP read of the endpoint with a timeout; returns the raw parsed body or throws a typed error |
| `src/quota/auth.ts` | Resolve the key: config → `MINIMAX_CN_API_KEY` → `~/.mmx/config.json` |
| `src/quota/service.ts` | `QuotaService extends Service`: `get`/`refresh`/`nextBoundary`/`onChange`; cache, in-flight de-duplication, `unknown` on failure |
| `src/quota/schedule.ts` | The boundary-armed timer + backoff, installed through `ctx.effect` |
| `src/tools/quota-status.ts` | The observation tool (cache-only) |
| `src/tools/select-model.ts` | The agent-judgement tool — started from the live-proven dynamic plugin source |
| `src/index-select-model.ts` | The second row: registers only the `select_model` tool |
| `src/policy/route-policy.ts` | The switching row: hysteresis, remembered-route restore |
| `src/index-route-policy.ts` | The third row: wires the policy to `quota/changed` |
| `scripts/build.mjs` | esbuild host bundle + `tsc` declarations |
| `cordis.patch.yml` | Three rows; the route policy carries `disabled: true` by default |
| `tests/support/*` | Shared fakes and helpers |
| `tests/harness/root.ts` | The one place a Context is assembled for this package |

Each row is its own entry (`lib/index.js`, `lib/index-select-model.js`, `lib/index-route-policy.js`) so a deployment enables them independently.

---

## Milestone 1 — Observation (Tasks 1–5)

### Task 1: Toolchain, Config, and the mount gate

**Files:** Create `src/config.ts`, `src/index.ts`, `tsconfig.json`, `tsconfig.build.json`, `scripts/build.mjs`, `tests/harness/root.ts`, `tests/harness/mount.test.ts`; Modify `package.json`

**Interfaces:** Produces `name = 'dsh-quota'`, `inject = ['tools']` (the row registers a tool, so `tools` is a hard dependency), `Config`, `QuotaConfig`, and a harness root factory. The other two rows declare: the select-model row `inject = ['tools']`, and the policy row `inject = ['quota']` -- a hard dependency on the observation row's service, so the policy waits for it rather than running blind.

- [ ] **Step 1:** Write the failing export test (mirroring `dsh-telegram/tests/unit/config.test.ts`): `name`, `inject`, and the schema defaults — `bucket === 'general'`, `maxAgeSeconds === 120`, `confirmations === 2`, `minSwitchIntervalSeconds === 300`, `blockBelowPercent === 5`, and that an unknown `bucket` type is rejected.
- [ ] **Step 2:** Run `pnpm vitest run tests/unit/config.test.ts` → FAIL (`src/config.ts` missing).
- [ ] **Step 3:** Implement. `package.json` scripts: `build` = `node scripts/build.mjs && tsc -p tsconfig.build.json`; `typecheck` = `tsc -p tsconfig.json`; `test` = `vitest run`. `tsconfig.json`: `target ES2023`, `module ESNext`, `moduleResolution Bundler`, `strict`, `noEmit`, `verbatimModuleSyntax`, `types: ["node"]`, `lib: ["ES2023"]`, including `src/**/*.ts` and `tests/**/*.ts`. `scripts/build.mjs` bundles each row entry to `lib/*.js` (ESM, `packages: 'external'`, sourcemap) and then **asserts the emitted bundle carries no `@deepseek-ai/dsh` specifier**, failing the build if it does — the assertion belongs in the build script rather than in a test, because a test reading the committed artifact would fail on any source edit made before the rebuild, so the rule would fight the workflow instead of enforcing itself. Also: `pnpm` 11 needs `pnpm-workspace.yaml`'s `allowBuilds: { esbuild: true }` or esbuild's postinstall is skipped (`ERR_PNPM_IGNORED_BUILDS`); the JS API still works, the `pnpm exec esbuild` shim does not.
- [ ] **Step 4:** `tests/harness/root.ts` — the single Context factory: `new Context()`, provide a **recording `tools` seam by default** (the row injects `tools`), accept `extra` for further seam fakes, and export `testConfig`. Two facts this step must honour, both learned in Task 1: **without the `tools` seam the fiber sits at `PENDING` and the row is silently inert** — `plugin()` does not throw and `await` resolves — so every harness case would pass vacuously; and `extra` must be merged **before** the first `provide`, because `ctx.provide` throws when a name is provided twice.
- [ ] **Step 5:** `tests/harness/mount.test.ts` — mount, `fiber.update()`, `fiber.dispose()`; all three must be clean, and the file becomes the permanent gate for every later task.
- [ ] **Step 6:** `pnpm typecheck && pnpm test && pnpm build`, then commit `chore: toolchain, config, and the mount gate`.

### Task 2: Pure parsing and the `usable` derivation

**Files:** Create `src/quota/parse.ts`, `tests/unit/parse.test.ts`, `tests/fixtures/model-remains.json`

**Interfaces:** Produces `pickBucket(body: unknown, bucket: string): BucketRecord | undefined`, `deriveUsable(record): { usable: 'yes'|'no'|'unknown'; warning?: string }`, `toSnapshot(...)`: `QuotaSnapshot`.

- [ ] **Step 1:** Write the failing tests as a table: a full `model_remains[]` fixture; an empty array; the bucket absent; `current_interval_status: 2` → `no`; `percentRemaining: 0` → `no`; `percentRemaining: 3` → `yes` **plus a warning**; `percentRemaining: 100` → `yes` with no warning; a body that is not an object → `unknown` with an error string; `remains_time` converted to both an ISO instant and seconds.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement with explicit narrowing only — no `as` casts, no `any`. Every absent field yields `null` in the snapshot rather than `0`.
- [ ] **Step 4:** **Mutation proofs:** make `deriveUsable` return `no` for a failed read (must fail the `unknown` case) and make it drop the `warning` (must fail the warning case). Revert both.
- [ ] **Step 5:** `pnpm typecheck && pnpm test`, then commit `feat(quota): pure bucket parsing and usable derivation`.

### Task 3: The HTTP read and auth resolution

**Files:** Create `src/quota/fetch.ts`, `src/quota/auth.ts`, `tests/contract/fetch.test.ts`

**Interfaces:** Produces `createQuotaFetcher(deps: { fetch?: typeof fetch; timeoutMs: number }): (url: string, key: string | undefined) => Promise<unknown>` and `resolveKey(explicit: string | undefined, env: NodeJS.ProcessEnv, home: string): string | undefined`.

- [ ] **Step 1:** Failing tests: the request carries `Authorization: Bearer <key>` when a key exists and no header when it does not; a non-2xx throws a typed error naming the status; a body that is not JSON throws; an aborted timeout throws; `resolveKey` prefers the explicit value, then the env var, then `~/.mmx/config.json`'s `api_key`, and returns `undefined` when the file is absent or malformed (never throws).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Auth is a **declared dev shortcut** — say so in the file, and name `ctx.credentials` as the product-grade alternative so a later reader knows it was a choice.
- [ ] **Step 4:** **Mutation proof:** drop the `Authorization` header when a key exists (must fail the header case).
- [ ] **Step 5:** Gates, then commit `feat(quota): endpoint read and key resolution`.

### Task 4: The service, the event, and the boundary timer

**Files:** Create `src/quota/service.ts`, `src/quota/schedule.ts`, `tests/contract/service.test.ts`, `tests/harness/quota.test.ts`; Modify `src/index.ts`

**Interfaces:** Produces `QuotaService extends Service` with `get(bucket?)`, `refresh(bucket?)`, `nextBoundary(bucket?)`, `onChange(cb)`; the row emits `quota/changed`.

- [ ] **Step 1:** Failing contract tests with an injected fake fetcher: `get()` before any read returns an `unknown` snapshot rather than throwing; after a successful read it reports `source: 'api'`; past `maxAgeSeconds` it reports `source: 'cache'`; two concurrent `refresh()` calls issue **one** request; a failed refresh leaves the previous value in place and marks `unknown` with the error; the service emits `quota/changed` **only** when the snapshot actually changes (two identical reads emit once).
- [ ] **Step 2:** Failing harness test: mounting the row publishes `ctx.quota`; `fiber.update()` re-registers without a duplicate error; `fiber.dispose()` leaves **no pending timer** (`vi.waitFor` on a spy over the scheduler, or assert the scheduler's disposer ran).
- [ ] **Step 3:** Implement. The scheduler arms exactly one timer at `windowEndsAt + jitter`, re-arms after each read, and backs off exponentially (5 s doubling to 5 min) after a failure. All of it lives in one `ctx.effect`.
- [ ] **Step 4:** **Mutation proofs:** remove the boundary re-arm (the follow-up read must not happen; the test asserting a second read after a short boundary fails) and remove the in-flight de-duplication (the concurrent-refresh count assertion fails).
- [ ] **Step 5:** Gates, then commit `feat(quota): service, change event, and boundary refresh`.

### Task 5: The `quota_status` tool

**Files:** Create `src/tools/quota-status.ts`, `tests/contract/quota-status.test.ts`; Modify `src/index.ts`

**Interfaces:** Consumes `QuotaService`; produces a registered tool named `quota_status` with one optional `bucket` parameter.

- [ ] **Step 1:** Failing tests: the tool returns a readable line naming the bucket, usability, percentage and reset time; it reads from the cache and issues **no** fetch of its own; a stale entry is reported as such.
- [ ] **Step 2:** Implement with **`defineTool` imported from `@deepseek-ai/dsh-tools`** (a *runtime* import -- the one sanctioned exception to the zero-dsh-import rule; declare the package as a dependency pinned to `0.1.5-rc.2` and narrow `scripts/build.mjs`'s assertion to allowlist it), passed to **`ctx.tools.register(definition)`** (which returns a disposer), wrapped in `ctx.effect` so the tool unwinds with the fiber. **`harness.defineTool` / `harness.registerTool` are the dynamic-Cordis *sandbox* signatures** injected by `@deepseek-ai/dsh-cordis-host-runner`; they do not exist in a host row, and reaching for them wastes a dispatch. `ctx.tools` (ToolRuntime) declares its own `inject = ['systemPrompt']`, which is why the seam this row depends on is `tools`.
- [ ] **Step 3:** Harness case: the tool is registered under the row and disappears after `fiber.dispose()`.
- [ ] **Step 4:** Gates, then commit `feat(quota): quota_status tool`.

**Milestone 1 acceptance:** the observation row mounts cleanly, publishes the service, emits on change, answers in one tool call, and never polls more than twice per window.

---

## Milestone 2 — Switching (Tasks 6–8)

### Task 6: The `select_model` tool

**Files:** Create `src/tools/select-model.ts`, `src/index-select-model.ts`, `tests/contract/select-model.test.ts`, `tests/harness/select-model.test.ts`

**Interfaces:** Produces a registered tool `select_model(status?, list?, provider?, model?, reasoningEffort?, sessionId?)`.

- [ ] **Step 1:** The starting point is **live-proven code**, not a design: the dynamic Cordis package `selmod-1`/`pkg-1` registered exactly this tool against the running harness. Its source of record can be read with the cordis Inspect tool (`cordis_inspect_self` with `pluginId: 'selmod-1'`, `packageId: 'pkg-1'`) from the session that created it, or recovered from this plan's sibling notes. Port it, then harden it against the project's standards (no `as` casts, explicit narrowing, contained errors).
- [ ] **Step 2:** Failing contract tests against a fake `sessionController`: `status` reports the calling session's committed route and says so when there is none committed; `list` reports the catalog's groups and default; a switch calls `selectModel` with exactly `{ sessionId, provider, model }` and includes `reasoningEffort` only when given; the default target is `exec.agent.session.id`; an explicit `sessionId` wins; no target at all refuses with a message; no route supplied refuses; a rejected route surfaces the controller's own reason.
- [ ] **Step 3:** Implement, registering through **`defineTool` from `@deepseek-ai/dsh-tools` (runtime import, the sanctioned exception) + `ctx.tools.register(...)` inside `ctx.effect`** — the durable host-row path. The dynamic plugin that proved this shape used the sandbox's `harness.*`, so **translate the shape, not the code**: the surface, the three modes and every refusal path are what is proven. The description must warn that a switch is logged as a visible notice and may start a new request series.
- [ ] **Step 4:** Harness case: the tool registers, and is gone after dispose.
- [ ] **Step 5:** **Mutation proofs:** make a missing target fall back to a hardcoded session (must fail the refusal case) and drop the `reasoningEffort` passthrough (must fail that assertion).
- [ ] **Step 6:** Gates, then commit `feat(select-model): agent-judgement route switching`.

### Task 7: The route policy row

**Files:** Create `src/policy/route-policy.ts`, `src/index-route-policy.ts`, `tests/contract/route-policy.test.ts`, `tests/harness/route-policy.test.ts`

**Interfaces:** Consumes `ctx.quota` and `ctx.sessionController`; produces the policy row. **`targets` is `string[]`, where empty means every live session** — Task 1's reading of the spec. If this task needs a richer shape (per-preset, per-origin, a deny list), refine `config.ts` here and say so: that is a deliberate change to a shared default, not a local choice.

**Filter rule (refined during design review):** the row switches only sessions whose committed `request/header` has `provider === config.throttledProvider`. A session already on the fallback is left alone; a session on a different provider is left alone. The opt-in to switch is implicit in the committed route, not in a per-session allowlist. This is the "soft gate" the operator described (background: `docs/DSH_SEAMS_FOR_QUOTA.md` §1, §3): it changes a route, never denies a call, and matches the spec's "advisory, never a gate" doctrine.

**Forbidden mechanism:** do **not** subscribe to `tools/pre-execute` to deny a sub-agent call because the quota is low. The arguments are frozen at that seam ([`docs/subsystems/tools.md:678-693`](https://github.com/deepseek-harness/deepseek-harness/blob/main/docs/subsystems/tools.md)), so a listener can only `allow` / `deny` / `cancel` / `ask`, and a denial is the deleted `QuotaGate` in a different uniform.

- [ ] **Step 1:** Failing tests against a fake `sessionController` and a fake `ctx.quota`: on a **confirmed** blocked state (the second consecutive blocked reading) each live session from `ctx.agents.list()` is switched to `fallback` and its previous route is remembered; on a **confirmed** refresh each session is restored to *its remembered* route, not the config default; a single blocked reading followed by a healthy one causes **no** switch at all (the hysteresis assertion); a `warning`-only reading causes no switch; a second transition inside `minSwitchIntervalSeconds` is skipped; when `enabled: false` no controller call is made; a fallback the controller rejects is logged and not retried until the next transition.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement, subscribing through `ctx.on('quota/changed', …)` (an effect) and keeping the confirmation counter and per-session memory in the row's own state.
- [ ] **Step 4:** Harness case: the row mounts beside the observation row, reacts to a synthetic `quota/changed`, and disposes cleanly.
- [ ] **Step 5:** **Mutation proofs:** remove the confirmation requirement (the wobble case must then switch, failing that assertion) and remove the remembered-route restore (the restore must then use the config default, failing that assertion).
- [ ] **Step 6:** Gates, then commit `feat(policy): quota-driven route switching with hysteresis`.

### Task 8: Bundle, docs, and profile cutover

**Files:** Create `cordis.patch.yml`, `README.md`, `AGENTS.md`; Modify `package.json`

- [ ] **Step 1:** `cordis.patch.yml` inserts three rows with distinct ids (`dsh-quota`, `dsh-quota-select-model`, `dsh-quota-route-policy`), the policy row carrying `disabled: true` by default so observation is safe to enable first.
- [ ] **Step 2:** `README.md`: what the three rows do, the two ways to read the quota (`mmx quota` and the endpoint), the fallback configuration, and the explicit statement that this is **advisory and never a gate** — naming the deleted `dsh-telegram` `QuotaGate` (`d8cfda2` → `5aa18f1`) so nobody reinstates it by accident.
- [ ] **Step 3:** `AGENTS.md`: the project layout, the commands, the pinned devDep discipline, and the three project standards (source-verified contracts, mutation proofs, no shape assertions on external data).
- [ ] **Step 4:** Link into the `web` profile as its own bundle (`pnpm add` a link, add to `dsh.profile.bundles`), restart `dsh web`, and verify end to end: `quota_status` answers in one call; `select_model` with `list` shows the catalog; a `select_model` switch to the session's **current** route completes with no notice (the safe no-op proof) before any real switch is attempted.
- [ ] **Step 5:** Run the full suite and `pnpm build` one final time; commit `docs: bundle rows, README, and profile cutover`.

**Milestone 2 acceptance:** an agent can inspect and change a route in one tool call; the policy switches and restores on confirmed transitions only; observation works with the policy disabled.

### Task 8a (optional): wake-on-refresh from a host timer

**Why this exists.** The operator asked: *"let the sub-agent deplete the quota, wait M minutes, then the main agent push the sub-agent to continue."* dsh has the seam (`ctx.subagents.sendMessage(...)`) but no shipped row uses it. The background doc (`docs/DSH_SEAMS_FOR_QUOTA.md` §4) records the seam and the three constraints. This task is **opt-in** — leave the policy row with the light answer (parent decides when to wake its child) unless the operator explicitly enables wake-on-refresh.

**Files:** Create `src/policy/wake-on-refresh.ts`, `src/index-wake-on-refresh.ts`, `tests/contract/wake-on-refresh.test.ts`, `tests/harness/wake-on-refresh.test.ts`; Modify `cordis.patch.yml`

**Interfaces:** Consumes `ctx.quota`, `ctx.subagents`, `ctx.agents`; produces a fourth row (independently disableable; `disabled: true` by default, same as Task 7's route-policy row). Subscribes to `quota/changed` and walks `ctx.agents.list()` to find continuable children whose direct parent's `request/header` has `provider === config.throttledProvider`; on a confirmed transition `usable: 'no' → usable: 'yes'`, calls `ctx.subagents.sendMessage(parentAgent, childId, [{ type: 'text', text: config.wakeMessage }], { signal })` for each.

**Constraints from the source** (each is a test case, not a guideline):

- `sendMessage` requires the **exact live** parent `Agent`; a session id is rejected. Walk `ctx.agents.list()` and match by `agent.id === recordedParentSessionId`.
- The parent must be currently active in this process. If the parent has settled/cold, reject the wake with a typed error; do not retry.
- The child must be continuable. One-shot children are not admitted by `sendMessage`. Filter them out before iterating.
- The signal passed to `sendMessage` must be owned by the row's `ctx.effect`, so disposal cleanly aborts an in-flight wake.

**Failure modes to test:**

- a parent on the throttled route, but already on the fallback → no wake
- a parent on the throttled route, with a continuable child whose descriptor is `one-shot` → no wake
- a parent on the throttled route, with a continuable child, but parent has settled → typed error, no wake
- a parent on a *different* route → no wake (filter rule)
- the wake itself rejects (e.g. target unknown) → logged, no retry until the next confirmed transition

**Why this is a separate row and not part of Task 7.** Two reasons. First, a host timer that wakes a child crosses one more doctrinal line than a route switch — the timer is the policy *and* decides when the child runs, not the model. Second, the seam is broader than quota (a future "park until human review" row would use the same primitives), so coupling it to quota would bury a general capability inside one specific policy.

- [ ] **Step 1:** Read `docs/DSH_SEAMS_FOR_QUOTA.md` §4.5 — every constraint there is a test case.
- [ ] **Step 2:** Write the failing contract tests against fake `ctx.quota`, `ctx.subagents`, and `ctx.agents`.
- [ ] **Step 3:** Write the failing harness case: a synthetic `quota/changed` to `usable: 'yes'` triggers `sendMessage` against the recorded child exactly once, with the parent's live `Agent` as the first argument.
- [ ] **Step 4:** Implement. All timer / signal / walker state lives inside one `ctx.effect`.
- [ ] **Step 5:** **Mutation proofs:** remove the live-parent walk (the cold-parent case must then `throw`, failing that assertion); remove the one-shot filter (the one-shot-child case must then call `sendMessage`, failing that assertion).
- [ ] **Step 6:** Gates, then commit `feat(policy): wake continuable sub-agents on confirmed quota refresh`.
- [ ] **Step 7:** Add the row to `cordis.patch.yml` with `disabled: true`. Document in `README.md` that this row is opt-in.

**Why this stays optional.** The light answer is sufficient when the parent agent is itself driving the loop: after the route is restored on confirmed refresh, the parent's next turn can call `send_message` itself, and the model decides when to wake the child. The wake-on-refresh row exists for deployments where the parent agent is parked / cold and no model turn is coming to dispatch the wake on its own. That is the right place to draw the line; the spec's "advisory, never a gate" rule is preserved because the wake is a one-shot event after a confirmed refresh, never an interruption of in-flight work.

---

## Self-review

- **Spec coverage:** §1–9 map to Tasks 1–5 (service, event, tool, boundary refresh); §10 maps to Task 7; §11 maps to Task 6; the bundle and cutover are Task 8. The deferred items in §8 (provider seam, credentials, UI row, `agent.inject`) have no task by design. Task 8a is opt-in and is not part of the binding schedule — it documents a seam that exists but is not needed unless the operator wants host-driven wake.
- **Ordering:** observation before switching, because the policy consumes the event the observation row emits; the tool row is independent of both and could ship first if the operator wants judgement-based switching before quota awareness.
- **Known gap, deliberate:** the plan's Task 6 points at live-proven code held in a dynamic plugin package rather than reproducing it inline. If that package is gone (a process restart destroys it), the implementer must rebuild it from §11's surface and rules — which is why §11 records the surface, the three modes, and every refusal path rather than only the idea.
- **Pre-dispatch seams (background):** `docs/DSH_SEAMS_FOR_QUOTA.md` is the topical background doc that informed the "soft gate" wording in Task 7 and the optional Task 8a. Read it before extending the policy row or designing anything that touches `tools/pre-execute` / `agent/request` / `agent/pre-step`.
- **Not covered here:** anything about `dsh-telegram`. This plan is a separate repository and must not touch that project's worktree, plan, or ledger.
