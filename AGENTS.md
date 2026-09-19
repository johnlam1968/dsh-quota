# dsh-quota

A host-plane DeepSeek Harness bundle that watches a model provider's rolling-window quota and lets both an **agent** (by its own judgement) and a **configured policy** (automatically) change a session's model route in flight.

Three rows in one package, each its own entry point so a deployment enables them independently:

| Row | Entry | What it does |
|---|---|---|
| quota (observation) | `lib/index.js` | Publishes `ctx.quota`, emits `quota/changed`, registers the `quota_status` tool. Arms one timer at the provider's own window boundary rather than polling |
| select-model (judgement) | `lib/index-select-model.js` | Registers the `select_model` tool so an agent can inspect or change a route itself |
| route-policy (automatic) | `lib/index-route-policy.js` | Consumes `quota/changed`; switches affected sessions to a fallback on a confirmed block and restores each session's remembered route on a confirmed refresh. Ships `disabled: true` |

**It is advisory and never a gate.** It changes a route; it never blocks, queues, or parks a message. A `QuotaGate` that did gate traffic once existed in the sibling project `dsh-telegram` (added `d8cfda2`, deleted `5aa18f1`) and was removed deliberately — do not reinstate it here.

## Handoff note

This project was designed in a different session and handed off. Everything the next session needs is in the repo; nothing lives only in a conversation.

- **Spec (binding):** `docs/superpowers/specs/2026-09-19-quota-awareness-design.md` — 11 sections. §3 architecture, §6 configuration, §10 the switching policy (with the guards against flapping), §11 the `select_model` tool surface and every refusal path.
- **Plan (the work):** `docs/superpowers/plans/2026-09-19-quota-awareness.md` — 8 tasks across two milestones, with the mutation proof each task must run.
- **SDD ledger (progress):** `<worktree>/.superpowers/sdd/2026-09-19-quota-awareness/progress.md` — gitignored scratch, but it is the recovery map: the pre-flight scan, Task 1's rulings, the mutation results, and the gate limits that were found by probing. Trust it and `git log` over recollection.
- **Branch and worktree:** `feat/quota-impl` at `.worktrees/quota-impl`. Continue there; `master` holds the docs.

**Current state:** Task 1 (toolchain, `Config`, the mount gate) is implemented and committed (`5d39d4a`, 9 tests, typecheck and build clean). Its review was dispatched from the previous session; if the verdict is not in the ledger, re-review the commit before trusting it. Tasks 2–8 are untouched.

**Next step:** Task 2 (pure parsing and the `usable` derivation). Generate its brief with the SDD skill's `scripts/task-brief <plan> 2`, dispatch an implementer per `subagent-driven-development`, and review the diff before moving on.

## How work is done here

The process is `subagent-driven-development`: one implementer per task, a task-scoped review of every diff (spec compliance **and** quality), a fix round if the review finds Critical or Important issues, and a whole-branch review at the end. Do not dispatch two implementers at once in this worktree.

**Four standards, carried over from `dsh-telegram` where they were earned:**

1. **Read seam contracts from the installed type definitions, never from memory or a cookbook.** In the sibling project this caught four plan defects before dispatch and missed two that review then caught. It applies to a parameter's *type* and to the **major version of the package that defines it**.
2. **Every task proves a test can fail** by naming a mutation that must break it, then reverting byte-identically and reporting both results. A test that survives its own behaviour being deleted is worse than no test, because it reads as coverage.
3. **Never assert a shape on external data.** The quota endpoint is untrusted input: narrow it with explicit checks, never `as` casts. The API's `unknown` returns are a feature.
4. **One harness case per seam the plugin registers into**, passing a fake through the harness root's `extra`.

## Toolchain facts that cost time to learn

- `pnpm` 11 needs `pnpm-workspace.yaml`'s `allowBuilds: { esbuild: true }` or esbuild's postinstall is skipped (`ERR_PNPM_IGNORED_BUILDS`). The esbuild **JS API** works; the `pnpm exec esbuild` shim does not.
- **`lib/` is tracked** (the profile links this checkout; nothing builds at install time). Run `pnpm build` and commit the regenerated `lib/` with the source that produced it.
- Dev dependencies are pinned to the versions the running profile resolves: `@deepseek-ai/cordis@4.0.2`, `dsh-*@0.1.5-rc.2`, `@types/node@^22.20.0`. npm `latest` for the dsh packages is `0.0.1-rc.1` — never install unpinned.
- **One runtime dsh import, and only one: `@deepseek-ai/dsh-tools`.** Every other dsh/cordis import is `import type`. `scripts/build.mjs` asserts the bundle carries no `@deepseek-ai/dsh` specifier **other than `@deepseek-ai/dsh-tools`**, and fails the build on anything else. The exception is forced, not a convenience: a host row cannot register a model tool without it. `defineTool` compiles the package's own parameter DSL into the enforced JSON Schema subset (`dsh-tools/lib/index.js:837-877`) and installs strict call validation; the DSL (`parameters: { path: { type: 'string', required: true } }`) is dsh-specific -- neither zod nor raw JSON Schema -- and the helpers that would let you hand-roll a definition (`parameterSchemaSpecToJsonSchema`, `assertSupportedJsonSchema`, `validateJsonSchemaValue`) are themselves runtime exports of the same package. `@deepseek-ai/dsh-tools` is therefore a **dependency**, pinned to the version the profile resolves (`0.1.5-rc.2`), not a devDependency. A second copy of the package in the plugin's tree is harmless: only its pure functions are used, and the definition object they produce is plain data handed to the real runtime.
- `zod` is **v4** here: the storage-domain package's `ZodType` comes from its own zod 4.6.5, and a zod-3 schema fails `tsc` (zod 3.25's bundled `zod/v4` fails too).
- **Tool registration in a host row** is `defineTool` from `@deepseek-ai/dsh-tools` passed to `ctx.tools.register(...)`, wrapped in `ctx.effect` (the one allowed runtime dsh import, see above). `harness.defineTool` / `harness.registerTool` are the dynamic-Cordis *sandbox* signatures and do not exist here. The parameter DSL is the package's own: read `@deepseek-ai/dsh-tools/README.md` "Register a tool" before writing one -- it is not zod and not JSON Schema, and `ctx.tools.register` re-validates the definition at registration (it throws `tool "x" must declare output { schema, render, presentationMeta? }`).
- **A missing hard dependency is silent.** Without its injected service a row's fiber sits at `PENDING`, `plugin()` does not throw, `await` resolves, and the row is inert — so a harness case without the seam passes vacuously. Task 1's gate asserts the fiber is ACTIVE for exactly this reason.

## Reference material

- **The Cordis + dsh contract:** `/home/john/CodingProjects/dsh-telegram/docs/DSH_CORDIS_SHAPES.md` — plugin forms, services and `inject`/`get`/`provide`, fibers and effect ownership, events, composition and patch semantics, the host-vs-preset planes, and a traps→correct-form table. Read it before touching dsh APIs.
- **The harness source of truth:** `/home/john/deepseek-harness` (source, docs, and the vendored Cordis). The installed packages under `@deepseek-ai/dsh/node_modules/` are what actually runs and are a **different version** from that checkout — check both when a contract matters.
- **How to read a quota by hand:** `mmx quota` (CLI; reads `~/.mmx/config.json`), or `GET https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains` with `Authorization: Bearer <key>`. Read the `model_remains[]` entry whose `model_name` is `general`: status 2 with 0% remaining means the current interval is blocked, and `remains_time` is the reset countdown in milliseconds. Weekly headroom is reported separately and can be 100% while the interval is blocked.

## Commands

```sh
pnpm install
pnpm typecheck     # tsc -p tsconfig.json
pnpm test          # vitest run
pnpm build         # esbuild bundles each row + tsc declarations, then asserts no dsh specifier but dsh-tools
```
