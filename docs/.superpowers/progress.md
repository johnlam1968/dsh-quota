# Progress — quota reset service (`feat/quota-groundup`)

The recovery map. Trust this and `git log` over recollection.

**Worktree:** `.worktrees/quota-groundup` · **Branch:** `feat/quota-groundup` (cut from `master` at `d9e8318`)
**Spec:** `docs/.superpowers/specs/2026-10-17-quota-reset-service.md` · **Plan:** `docs/.superpowers/plans/2026-10-17-quota-reset-service.md`

Runtime: dsh `0.1.7-rc.2`, Cordis `4.0.4`, schemastery `3.18.4`.

## Status

| # | Increment | State |
|---|---|---|
| 1 | Pure core — `probe` `derive` `schedule` `block` | done, 12 mutations |
| 2 | Rendering — `format` `notice` | done, 6 mutations |
| 3 | Service — `config` `state` `index` | done, 6 mutations |
| 0 | Lifecycle gate — `tests/harness/` | done, 6 cases |
| 4–5 | Subscription + composition | **not started** — planned |
| 9 | Contract tier | **not started** — planned |
| — | Peer cross-check fixes | done, 4 items |

`93 tests · 24/24 mutations killed · typecheck clean` as of `f74aec6`.

## Test tiers, adopted from `feat/quota-impl`

Its suite is further along and better factored than the plan this branch started
from. Three tiers, each proving a different thing:

| Tier | Mounts | Drives | Proves |
|---|---|---|---|
| `unit/` | nothing | pure functions | the behaviour of a decision |
| `contract/` | a real `Context` | `ctx.emit(...)`, stubbed globals | that the wiring *calls* the behaviour |
| `harness/` | a real `Context` | lifecycle only | that the row mounts, updates, disposes, owns its effects |

Rules taken verbatim in spirit:

- **The gate is not a late task.** `feat/quota-impl` runs its mount gate "from
  Task 1 onward", because two P0 defects there were lifecycle defects a
  plain-object `ctx` mock cannot see. This branch's plan had it last; it is now
  written and passing.
- **No case calls a handler directly** — it "would prove the handler body and
  nothing about whether anything calls it". This is exactly the discipline
  `src/index.ts` lacks today.
- **Globals, not injected seams.** "Each one is a knob that can be wired wrong."
  A scripted `fetch` plus `vi.useFakeTimers()` tests the real call path.
- **Assert on non-actions, not just outcomes.** `expect(vi.getTimerCount()).toBe(0)`
  — not merely "did not wake", but "did not arm".
- **Assert the waterfall is delegated.** `agent/request-error` is a waterfall;
  swallowing `next` would silently make every quota refusal terminal.

## Cordis facts the gate established

- **`Context.plugin()` does NOT take `exports.default ?? exports`.** That is a
  *Loader* convenience. A namespace import of a Service class hands `plugin()` an
  object with no `apply` and it refuses to mount. Caught on the first run.
- **`fiber.update()` is typed `void`** and restarts behind the async
  `internal/update` waterfall, so `await fiber.update(...)` awaits `undefined`
  and reads the fiber mid-`UNLOADING` (state 5). Poll for the settled state, then
  assert it — otherwise a stuck fiber passes quietly.
- **`FiberState` is an ambient `const enum`** whose members `isolatedModules`
  forbids reading; the numbers are written out.
- **`makeRoot` must merge `extra` before the first `provide`** — cordis refuses
  to provide a name twice in one scope, so an override must win the merge rather
  than overwrite an already-registered default.
- **`new Context()` is the whole harness.** Services resolve through the proxy
  and fibers own their effects exactly as under `dsh web`, so `apply` fails in
  the test rather than at deployment.

## Rulings worth not re-deriving

- **`PlanStatus` carries no `usable`.** Usable depends on the routed model (video models skip the 5-hour window), so `derive.ts` owns it. Two sources of truth for "can I run?" is the bug the type refuses to permit.
- **The edge is per blocked record, not per account.** A video session blocked on the weekly window and a text session on the 5-hour one are woken by their own resets.
- **A failed read must not overwrite the last good status.** It bumps the streak only. Overwriting erases "a session was blocked", so one dropped request mid-exhaustion swallows the reset after it. *Caught by a test.*
- **`BlockRecord` carries the window.** At wake time every row reads healthy, so the current status cannot say which window expired. *Caught by a test producing "the usage usage window has reset".*
- **The schedule's ceiling is load-bearing.** `maxIntervalMs` bounds how long a *new* block goes unnoticed. A 4-hour wait costs 16 probes, not `divisor` probes. *The original doc comment claimed 4; the test proved it wrong.*
- **Runtime dsh imports are `cordis` + `dsh-tools`, both forced.** `extends Service` is a real base class; `defineTool` compiles the parameter DSL. `@deepseek-ai/dsh-llm` is test-only.
- **The prompt line does not read `selection.current`.** It would resolve the route perfectly at assembly time, but makes the row depend on the optional gateway-specific `dsh-api-session-controller` for its core behaviour. Two triggers on the universal event stream cost two registrations no prompt ever observes.

## What the peer cross-check caught (all verified against 0.1.7-rc.2)

1. **`require('node:fs')` in ESM.** Threw `ReferenceError` into a bare `catch {}` whose comment called persistence "an optimisation". The row looked healthy and wrote no marker. → top-level import; the catch now reports.
2. **`agent/request-error` misses thrown failures.** Guarded in the installed loop by `if (finish.kind === 'error' || 'aborted')`. A thrown transport failure jumps past it and surfaces only as `agent/error`, whose payload has no `failure`. → both channels observed; `unknown` narrowed by explicit checks.
3. **The raw vendor code is never in `code`.** `dsh-llm-pi-ai` runs `classifyPiAiError(message)` → `isQuotaExceededError` → `QUOTA_EXCEEDED_CODE = 'QUOTA'`. MiniMax's `2056` only ever appears in the message. → `HARNESS_QUOTA_CODES` matched exactly; the regex net demoted to a fallback.
4. **`createUserMessage` is not needed at runtime.** It is `deepFreeze(structuredClone({…input, role:'user', id: brandString(randomUUID())}))` — three lines. → reproduced in `message.ts`; dsh-llm moved to devDependencies and used as a **test-only oracle**, so the hand-rolled literal cannot drift silently.

## Toolchain facts that cost time

- **Typecheck before commit, not alongside tests.** `195bd5e` and `2c43ddd` both went in with a red `tsc` because tests were green and `tsc` was not run. Now `pnpm typecheck && pnpm test` precedes every commit.
- **`Schemastery.ObjectT` intersects with `Dict`**, which poisons every downstream `Partial<>` and yields errors about `constructor`. `QuotaConfig` is written out by hand; the defaults test asserts the exact resolved key set of both it and `schedule`, so schema drift fails a test.
- **`z.resolve(data, schema, options)`** fills defaults and coerces. It does **not** validate required fields — that is the Loader's job at mount time (Task 9).
- **`UserMessage['source']` is a union** including `{ kind: 'user' }`, a variant with no `form`. Hence `QuotaNoticeSource` / `QuotaNotice`.
- **The mutation runner restores from the in-memory original**, not `git checkout`. The git path could not revert an untracked file, and when the process died mid-run it left a mutated `src/format.ts` behind.

## Open gaps

- **`src/index.ts` has no behaviour test.** The lifecycle gate (Task 0) mounts,
  updates, disposes and proves the timer is owned — but nothing yet exercises a
  probe, a failure or a delivery. A mutation deleting the `agent/error` listener
  still survives. Task 9's contract tier closes it.
- **The weekly window's field path is unconfirmed.** `derive.ts` treats an absent weekly row as "not blocked" — the only safe direction. Adding it is one row in `classifyQuota`.
- **`agent/error` carries no provider**, so that channel trusts `agent.options`. A session whose effective route differs from its options could be recorded against the wrong plan. Task 9's second case should exercise it.

## Next

Task 9 first, not Task 4. The contract tier is what makes any later claim about
`src/index.ts` mean something, and it is cheap: the harness root already exists.
Then Task 4 — the pure reconcile reducer, a four-case decision table.
