# dsh-quota

A host-plane DeepSeek Harness bundle that watches an LLM provider's rolling usage windows, tells an agent where it stands, and **wakes it when a window that blocked it resets**.

**It is advisory and never a gate.** It observes, it renders a line of context, it registers a tool, and at most it *adds* one user-role message. It never blocks, denies, queues or parks a request. A `QuotaGate` that did gate traffic once existed in the sibling project `dsh-telegram` (added `d8cfda2`, deleted `5aa18f1`) — do not reinstate it here.

## Two implementations, one live

| Branch | Worktree | Status |
|---|---|---|
| **`feat/quota-groundup`** | `.worktrees/quota-groundup` | **Built, installed and ACTIVE** in the `web` profile. This is the plugin. |
| `feat/quota-impl` | `.worktrees/quota-impl` | An earlier, different design: three rows in one package (observation / `select_model` / route-policy). Not installed. Its spec and plan live in `docs/superpowers/`. |

They do not supersede each other; both are valid. Where this file describes one row, it describes `feat/quota-groundup`.

## What the live plugin does

One row, `QuotaService extends Service`, published as `ctx.quota`:

1. **Probe** — reads the provider's quota endpoint on a self-rescheduling timer. The provider reports the countdown to each window boundary, so the reset time is *known*: the timer schedules, the probe only verifies. A 4-hour wait costs ~16 requests, not the ~960 a fixed 15-second floor would spend.
2. **Report** — a session whose committed route is the watched provider gets a `<provider-quota>` line in its system prompt, and a `quota_status` tool it can call. Both derive from the same function, so they cannot disagree.
3. **Wake** — when a window that blocked a session resets, one `form: 'notice'` user-role message is delivered through `agent.followup(...)`. That is the whole point of the plugin: a turn that died on a usage refusal otherwise never retries, even after the limit is gone.

Subscription is **derived, not stored**: recomputed from the session's route on `model/selection` and `request/context`, so it follows a provider switch in both directions.

## Current state

`feat/quota-groundup`, 12 commits, branch cut from `master` at `d9e8318`.

- Installed: `/home/john/.dsh/profiles/web/node_modules/dsh-quota` → symlink to the worktree; `lib/index.js` present; listed in profile `dependencies` and `dsh.profile.bundles`; `list_plugins` reports `fiberPhase: "active"`.
- Verified against the **live** endpoint with no environment variable set: 4 rows, no error.
- **Not yet observed:** the wake actually firing. Every part is verified individually; the assembled path only resolves when the wall is hit.

Key documents: `docs/.superpowers/live-response-shape.md` (the measured endpoint shape, and the one trap it contains), `docs/.superpowers/specs/` and `plans/` (the design and the remaining plan), `docs/.superpowers/progress.md` (state ledger).

## Harness gaps — report these, do not work around them silently

Found by reading the installed declarations and loading the built bundle. None of them is ours to fix; if one is hit again, say so rather than inventing a local convention.

- **`PromptContext.required` is documented but not implemented.** `docs/subsystems/system-prompt.md` describes it as *"Keep this operational context when optional runtime context is disabled"*, but the installed `dsh-system-prompt`'s `PromptContext` declares only `name`, `order`, `text`, and the implementation never reads `required`. **Consequence:** a deployment calling `suppressRuntimeContext()` can still hide the quota line from a blocked agent.
- **`model/selection` is missing from the installed `SessionEventMap`.** The runtime appends it (`dsh-api-session-controller` calls `session.append('model/selection', …)`) and `known-event-types.js` lists it, but the installed type omits it — so TypeScript narrows `event.type === 'model/selection'` to `never`. Merged back through the documented merge-extension, with the payload observed in a real session log.
- **`plugin_validate` false-OKs `required` in an output schema.** `required` is a *parameters*-DSL concept; an `output.schema` object node rejects it at registration with `schema.required is not supported by the value schema DSL`. The validator returns OK on exactly that.
- **A nullable schema field is `oneOf: [{type:'number'}, {type:'null'}]`, never `type: ['number','null']`.** Legal types are a single value.
- **`Context.plugin()` does not take `exports.default ?? exports`.** That is a *Loader* convenience. A namespace import of a Service class hands it an object with no `apply` and it refuses to mount.
- **`fiber.update()` is typed `void`** and restarts behind the async `internal/update` waterfall, so `await fiber.update(...)` awaits `undefined` and reads the fiber mid-`UNLOADING`.

## How work is done here

**Verify against the running harness, not against a mock.** The plugin is built for this harness and this host; `plugin_doc`, `plugin_validate`, `plugin_scaffold`, `cordis_inspect_query`, and `plugin_manager` answer questions faster and more truthfully than a test that stubs globals and shares process-global state across files. The suite in `tests/` exists and is useful as a regression net, but it is **not** the gate — two cases there are parked (`.skip`) for exactly this reason.

Concretely, the loop that works:

1. `plugin_doc(topic=…)` then `plugin_validate` the thing you are about to write.
2. `pnpm build` and **load the built bundle** — `scripts/smoke.mjs` mounts `lib/index.js` on a real `Context` and drives a route change. Registration-time throws only happen here.
3. `scripts/live-probe.mjs` for anything touching the real endpoint.
4. `plugin_manager install_bundle` + `cordis_inspect_query Config.listConfigs` to confirm it is live.

**Never call the oversized inspection tools casually.** `plugin_manager list_bundles`, `list_plugins` (195 entries) and `cordis_inspect_query Config.listConfigs` return payloads large enough to 500 the server through the tool bridge. Use targeted calls or `bash`.

## Standards that earned their place here

1. **Read seam contracts from the installed type definitions**, never from memory or a cookbook.
2. **An advisory plugin must never be able to fail session creation.** `agent/created` is a **serial** dispatch: a throw in a listener fails the *creation*. So the tool definition is built **once at mount**, not per subscription (`defineTool` validates at call time — a per-subscription call would have surfaced a schema error inside that dispatch), and the listener body is contained with anything swallowed logged.
3. **A `catch` that is load-bearing must report.** A silent swallow hid a `require` that does not exist in ESM, leaving the row looking healthy while writing nothing.
4. **Never assert a shape on external data.** The quota endpoint is untrusted: narrow with explicit checks, never `as`.
5. **Typecheck before commit, not alongside tests.** Two commits shipped with a red `tsc` because the tests were green and `tsc` was not run.

## Toolchain facts that cost time

- Runtime versions are what the profile resolves, and they are **not** what npm `latest` says (`0.0.1-rc.1`). Currently `@deepseek-ai/cordis@4.0.4`, `dsh-*@0.1.7-rc.2`, `@deepseek-ai/schemastery@3.18.4`.
- **Runtime dsh imports are an allowlist of three**: `cordis` (`extends Service` is a real base class), `dsh-tools` (`defineTool`), `schemastery` (the Config schema evaluates at load). `scripts/build.mjs` asserts the emitted bundle imports nothing else — and it reads the **emitted specifiers**, not metafile inputs, because inputs are node_modules-relative paths and matching them silently finds nothing.
- **`lib/` is tracked.** The profile links this checkout and nothing builds at install time, so the built entry point must be committed with its source.
- **`pnpm` 11** needs `pnpm-workspace.yaml`'s `allowBuilds: { esbuild: true }` or esbuild's postinstall is skipped.
- **A missing hard dependency is silent.** Without its injected service a fiber sits at `PENDING`, `plugin()` does not throw, and the row is inert while looking mounted. It was caught by adding `systemPrompt` and `tools` to `inject` and watching 14 tests fail.
- The credential comes from `MINIMAX_API_KEY`, falling back to `~/.mmx/config.json` (the MiniMax CLI's own file). Without the fallback the row mounts and then reports every read as unauthenticated — mounted but blind.
- `FiberState` is an ambient `const enum` whose members `isolatedModules` forbids reading; the numbers are written out.

## The endpoint, measured

`GET https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains` returns `model_remains` with **one entry per account group** — `general` and `video` were both observed — and **every entry carries both windows** as parallel field families (`current_interval_status` / `current_weekly_status`, …, `remains_time` / `weekly_remains_time`).

**The trap:** `current_weekly_status` was observed at **3** while `current_weekly_remaining_percent` read **100**. The status vocabulary is not shared between the windows, so the block rule differs:

- **5h** blocks on `status === 2 || percent === 0` (the reference script's rule).
- **weekly** blocks on **`percent === 0` only** — status is parsed for diagnostics and never blocks, because `3` cannot be mapped without hitting the wall.

Blocking on the unmapped status would halt every session for no reason. And the asymmetry is safe anyway: the `2056` refusal is the ground truth for a block; the probe only has to detect *recovery*, which a non-zero percentage reports correctly under either rule.

## Commands

```sh
pnpm install
pnpm typecheck     # tsc -p tsconfig.json
pnpm test          # vitest run — regression net, not the gate
pnpm build         # esbuild bundle + declarations + runtime-import allowlist
node scripts/smoke.mjs      # mount the BUILT bundle, drive a route change
node scripts/live-probe.mjs # one real read through our own parser
node scripts/mutate.mjs    # 37 mutations; exits non-zero if one survives
```

## Reference material

- **The harness docs:** `/home/john/deepseek-harness/docs`. The installed packages under `@deepseek-ai/dsh/node_modules/` are a **different version** from that checkout — the installed declarations win, and they are what `plugin_doc` reflects.
- **The plugin-authoring skills are the fast path**: `dsh-plugin-onboarding`, `dsh-plugin-dev-kb`, `cordis-plugin-development`, `editing-cordis-compositions` (read it *with* `cordis-composition-reference` for the patch dialect).
- **Read a quota by hand:** `mmx quota`, or the endpoint above with `Authorization: Bearer <key>` from `~/.mmx/config.json`.
