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

**A cold session used to go one whole turn blind — fixed.** `agent/created` reads `agent.session.requestContext()`, which is `undefined` for a session created for its first request, and `request/context` lands *after* that step's assembly, so the subscription could not take effect until the next step. Measured in a live session log, not inferred: the `request/header` with `reason: "initial"` carried 48 tools, and the next one (`reason: "change"`, 5.6 s later, after one tool round-trip) carried 49, with `quota_status` inserted between `present` and `read`. `agent/created` now falls back to `agent.options` — the same source `onReset` already trusts to decide who to wake — so turn 1 carries both surfaces. `scripts/smoke.mjs` asserts the fallback fires **before any route event**, and that it does not over-subscribe a session on another provider; that check goes red against the pre-fix build. The wake was never affected: `onReset` walks `ctx.agents.list()` and never reads `bound`. **Do not read a row's absence from an opening roster as "not mounted" or "not subscribed".**

## Current state

`feat/quota-groundup`, 33 commits, branch cut from `master` at `d9e8318`.

- Installed: `/home/john/.dsh/profiles/web/node_modules/dsh-quota` → symlink to the worktree; `lib/index.js` present; listed in profile `dependencies` and `dsh.profile.bundles`; `list_plugins` reports `fiberPhase: "active"`.
- Verified against the **live** endpoint with no environment variable set: 4 rows, no error.
- The wake **is** verified — `scripts/wake-check.mjs` drives the blocked→usable flip against the built bundle and asserts the delivered message. What is still unobserved is that flip happening against the *real* provider, which only occurs when the wall is hit.
- **All three surfaces are verified against the running host.** Prompt line: reproduced verbatim from inside a live session's own runtime context after forcing the threshold (see below). Tool: called live, returning real endpoint numbers. Cold-session subscription: a session created after the restart carried `quota_status` in its `reason: "initial"` request header, 46 tools.

**The prompt line is SEEDED ONCE per session, then goes quiet.** `renderQuotaStatus` returns `''` in exactly two cases — never read, and the read failed. Given a reading it always renders, and `reconcile`'s `text` callback returns it once and `''` thereafter. A new session therefore knows where it stands from turn one, without a stale countdown being re-injected every step. What is graded is the wording, not the presence: blocked says so plainly, a low window says to pace, a comfortable one just states the numbers. A session created before the first successful probe is not marked seeded until it has actually rendered something, so it does not spend its one briefing on an empty string. `detach()` clears the mark, so a session that leaves and returns on the watched provider is briefed again.

**Why it is not a standing line.** A countdown written into a prompt is stale the moment it is read, and repeating it every step is wallpaper carrying wrong numbers. The `quota_status` tool is the live path; the prompt line is the opening briefing.

**This ambiguity already cost a round of misdiagnosis.** The line used to be gated on `lowWaterMarkPercent`, so a healthy account showed nothing — and silence-because-healthy is indistinguishable, from the outside, from a registration that never resolved. It prompted a scope-chain diagnosis that was wrong, a `set_bundle` reload theory that was half wrong, and a search of 897 session logs that could not see the line because the index does not mirror runtime contexts. Gate nothing that an operator needs to see.

**Session logs CAN confirm the prompt line — look for a named section, not a string.** Runtime contexts are persisted as a `user/message` carrying `source.kind: "runtime-context"`, `form: "snapshot"`, and a `sections` array. A healthy account's snapshot has exactly two entries, `sandbox:policy` and `approval:policy`; with the threshold forced high, a third named `quota-usage-status` appears beside them. **Absence is ambiguous** — it means either "registered but rendered empty" or "never registered" — so a negative result still needs the forced threshold before it means anything. `system/message` is separate and holds only the base prompt. `session_index_search` cannot find the line: its mirror indexes agent text and tool results, not the runtime-context snapshot.

Key documents: `docs/.superpowers/live-response-shape.md` (the measured endpoint shape, and the one trap it contains), `docs/.superpowers/specs/` and `plans/` (the design and the remaining plan), `docs/.superpowers/progress.md` (state ledger).

## Harness gaps — report these, do not work around them silently

Found by reading the installed declarations and loading the built bundle. None of them is ours to fix; if one is hit again, say so rather than inventing a local convention.

- **`PromptContext.required` is documented but not implemented.** `docs/subsystems/system-prompt.md` describes it as *"Keep this operational context when optional runtime context is disabled"*, but the installed `dsh-system-prompt`'s `PromptContext` declares only `name`, `order`, `text`, and the implementation never reads `required`. **Consequence:** a deployment calling `suppressRuntimeContext()` can still hide the quota line from a blocked agent.
- **`model/selection` is missing from the installed `SessionEventMap`.** The runtime appends it (`dsh-api-session-controller` calls `session.append('model/selection', …)`) and `known-event-types.js` lists it, but the installed type omits it — so TypeScript narrows `event.type === 'model/selection'` to `never`. Merged back through the documented merge-extension, with the payload observed in a real session log.
- **`plugin_validate` false-OKs `required` in an output schema.** `required` is a *parameters*-DSL concept; an `output.schema` object node rejects it at registration with `schema.required is not supported by the value schema DSL`. The validator returns OK on exactly that.
- **A nullable schema field is `oneOf: [{type:'number'}, {type:'null'}]`, never `type: ['number','null']`.** Legal types are a single value.
- **`Context.plugin()` does not take `exports.default ?? exports`.** That is a *Loader* convenience. A namespace import of a Service class hands it an object with no `apply` and it refuses to mount.
- **`fiber.update()` is typed `void`** and restarts behind the async `internal/update` waterfall, so `await fiber.update(...)` awaits `undefined` and reads the fiber mid-`UNLOADING`.
- **`AssembleContext` is declared `{ scope?, signal? }` but carries `agent`.** `dsh-agent/lib/types/dispatch.js:92` returns `{ agent, scope: agent, signal }`, and `dsh-sandbox-policy` depends on `context.agent?.session`. The declared type hides it; read the installed implementation.

**DEBUNKED — do not re-investigate: per-agent runtime contexts resolve fine for root sessions.** `agent.ctx.systemPrompt.context({ … })` looks like a subagent-only pattern, because `dsh-subagent` registers on a minted `childCtx`. It is not. `assembleContextFor` sets `scope: agent`, `dsh-scope`'s `Layers.effect` keys the layer by `scopeOf(agent.ctx)`, and `chainLayers(agent)` finds it — measured, with the line reproduced verbatim from inside a live session. An earlier diagnosis blamed this scope chain for a missing prompt line; the real cause was the low-water filter emptying the text. Re-read `format.ts` before blaming the scope machinery.

## How work is done here

**Verify against the running harness, not against a mock.** The plugin is built for this harness and this host, so the oracle is the harness: `plugin_doc`, `plugin_validate`, `plugin_scaffold`, `cordis_inspect_query`, `plugin_manager`, and three scripts that drive the **built** bundle. `pnpm test` does not exist — the suite was deleted deliberately. Write tests when something needs them, not by default.

Concretely, the loop that works:

1. `plugin_doc(topic=…)` then `plugin_validate` the thing you are about to write.
2. `pnpm build`, then `node scripts/smoke.mjs` — mounts `lib/index.js` on a real `Context` and drives a provider switch. Registration-time throws only happen here.
3. `node scripts/wake-check.mjs` — drives the blocked→usable flip with a scripted endpoint. This is the path no live run can exercise until the wall is hit, so it is the one thing that must never be assumed.
4. `node scripts/live-probe.mjs` — one real read through our own parser.
5. `plugin_manager install_bundle`, then a targeted `cordis_inspect_query Config.listConfigs` to confirm it is live.

**Why the suite went.** It reached 108 tests and had started costing more than it returned: two cases were order-dependent on `process.env` and a global `fetch` stub shared across files, and chasing that meant per-file isolation config. Meanwhile `plugin_validate` caught a registration-time throw the suite never would have, because the suite never loaded the built bundle. Verification that runs against the thing being shipped beat verification that runs against a stand-in for it.

**Never call the oversized inspection tools casually.** `plugin_manager list_bundles`, `list_plugins` (195 entries) and `cordis_inspect_query Config.listConfigs` return payloads large enough to 500 the server through the tool bridge. Use targeted calls or `bash`.

- **A linked local bundle's CODE cannot be reloaded; only its Config can.** `plugin_manager set_bundle` re-applies the patch, so a changed `cordis.patch.yml` takes effect immediately — measured, not assumed: `lowWaterMarkPercent` 20 → 100 → 20 each took effect within one probe interval, and the tool returned `changed: false` on **every** call including both that changed the value. **`changed: false` reports the enable stage, not the config; it does not mean the patch was skipped.** But the Loader caches the module it resolved at first install, so edits to `lib/index.js` and `src/` do **not** reach the running host: neither `remove_bundle` + `install_bundle` nor changing `main`/`exports` to a new specifier (`lib/index.v2.js`) forces a fresh import. Only a host restart picks up new code. **This is a trap:** it makes a live test appear to pass or fail against code the host is not running. Confirm which build is live before believing any live observation.

## Standards that earned their place here

1. **Read seam contracts from the installed type definitions**, never from memory or a cookbook.
2. **An advisory plugin must never be able to fail session creation.** `agent/created` is a **serial** dispatch: a throw in a listener fails the *creation*. So the tool definition is built **once at mount**, not per subscription (`defineTool` validates at call time — a per-subscription call would have surfaced a schema error inside that dispatch), and the listener body is contained with anything swallowed logged.
3. **A `catch` that is load-bearing must report.** A silent swallow hid a `require` that does not exist in ESM, leaving the row looking healthy while writing nothing.
4. **The probe is the only source of truth for account state.** One boolean (`wasBlocked`) is the whole reset edge. An earlier design also read `agent/request-error` and `agent/error` to learn which session was blocked; that was a second source of truth that could disagree with the probe, and it needed provider-wording regexes, two channels, and an accepted limitation. Do not reintroduce it.
5. **Never assert a shape on external data.** The quota endpoint is untrusted: narrow with explicit checks, never `as`.
6. **Typecheck before commit.** Two commits shipped with a red `tsc` because something else was green and `tsc` was not run. `pnpm typecheck` is its own step; never infer it from anything else passing.

## Toolchain facts that cost time

- Runtime versions are what the profile resolves, and they are **not** what npm `latest` says (`0.0.1-rc.1`). Currently `@deepseek-ai/cordis@4.0.4`, `dsh-*@0.1.7-rc.2`, `@deepseek-ai/schemastery@3.18.4`.
- **Runtime dsh imports are an allowlist of three**: `cordis` (`extends Service` is a real base class), `dsh-tools` (`defineTool`), `schemastery` (the Config schema evaluates at load). `scripts/build.mjs` asserts the emitted bundle imports nothing else — and it reads the **emitted specifiers**, not metafile inputs, because inputs are node_modules-relative paths and matching them silently finds nothing.
- **`lib/` is tracked.** The profile links this checkout and nothing builds at install time, so the built entry point must be committed with its source.
- **`pnpm` 11** needs `pnpm-workspace.yaml`'s `allowBuilds: { esbuild: true }` or esbuild's postinstall is skipped.
- **A missing hard dependency is silent.** Without its injected service a fiber sits at `PENDING`, `plugin()` does not throw, and the row is inert while looking mounted. It was caught by adding `systemPrompt` and `tools` to `inject` and watching the harness cases go red at PENDING.
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
pnpm build         # esbuild bundle + declarations + runtime-import allowlist

node scripts/smoke.mjs      # mount the BUILT bundle, drive a provider switch
node scripts/wake-check.mjs # drive the blocked -> usable flip with a stub endpoint
node scripts/live-probe.mjs # one real read through our own parser
```

## Reference material

- **The harness docs:** `/home/john/deepseek-harness/docs`. The installed packages under `@deepseek-ai/dsh/node_modules/` are a **different version** from that checkout — the installed declarations win, and they are what `plugin_doc` reflects.
- **The plugin-authoring skills are the fast path**: `dsh-plugin-onboarding`, `dsh-plugin-dev-kb`, `cordis-plugin-development`, `editing-cordis-compositions` (read it *with* `cordis-composition-reference` for the patch dialect).
- **Read a quota by hand:** `mmx quota`, or the endpoint above with `Authorization: Bearer <key>` from `~/.mmx/config.json`.
