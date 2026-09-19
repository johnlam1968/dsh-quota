# dsh-quota — model window quota awareness for agent routing

**Date:** 2026-09-19
**Status:** awaiting review
**Approach:** B — service + event + tool (operator-approved)
**Companion project:** `dsh-telegram` (separate concern, separate row, separate repo)

---

## 1. Why

A running agent — typically the orchestrator deciding which model to dispatch work to — makes that decision **blind**. On 2026-09-19 the `minimax-cn` five-hour window was exhausted (`current_interval_remaining_percent: 0`, `current_interval_status: 2`) while `current_weekly_remaining_percent` read 100. The state was invisible until a dispatch went slow or failed, and the weekly figure actively misleads: it says nothing about the current interval.

Two read routes already exist, and both were verified working:

- `mmx quota` — a CLI that reads `~/.mmx/config.json`;
- `GET https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains` with `Authorization: Bearer <key>`, where the key comes from `MINIMAX_CN_API_KEY` or that same config file.

Both return `model_remains[]` with per-bucket `start_time`, `end_time`, `remains_time`, `current_interval_status`, `current_interval_remaining_percent`, and the weekly equivalents.

**The fact that makes this cheap:** the window is *scheduled*, not merely measured. `end_time` and `remains_time` give the refresh instant exactly, so awareness does not require polling — it requires one read and one timer aimed at the boundary.

## 2. Goals

1. Answer "can I dispatch to this provider right now, and when does that change?" in **one tool call**, in a decision-shaped form rather than raw JSON.
2. Publish the state so any other row can react without re-implementing the read.
3. Be precise at the window boundary without a fixed poll cadence.

### Non-goals

- **Not a gate.** No blocking, no queueing, no message parking. That was `dsh-telegram`'s `QuotaGate` (added `d8cfda2`, deleted `5aa18f1`) and it stays deleted. This informs a decision; it never makes one. A future reader must not "restore" it here.
- **No push into a running agent** in this version — no `agent.inject`. Pull first; revisit only if the pull proves insufficient.
- No UI, no notifications.
- Not inside `dsh-telegram`: that is a published bundle for Telegram transport, and this is dev-workflow tooling for a different concern.
- **No abstract provider seam yet.** One implementation is not a seam. `fetchQuota()` is kept in one function so extracting a `QuotaProvider` later is mechanical.

## 3. Architecture

One **host-plane** bundle row, mounted in a profile. Host plane because its consumers cross sessions — any agent or orchestrator in the process reads it — so it cannot be an agent preset.

It publishes `ctx.quota` (a `Service`), emits `quota/changed`, and registers one model-facing tool, `quota_status`.

- **Auth** is a declared dev shortcut: `MINIMAX_CN_API_KEY`, else `~/.mmx/config.json`'s `api_key` — the file the CLI itself reads, which is why the two routes agree. `ctx.credentials` is the product-grade alternative and is deliberately deferred; the file says so, so a future reader knows it was a choice rather than an oversight.
- **It never throws into a caller.** A failed read yields `usable: 'unknown'` plus the error.
- **It never blocks a tool call on the network.** `get()` is synchronous over cached state; a refresh happens in the background.

## 4. Interfaces

```ts
/** 'general' is the bucket that covers MiniMax-M3. */
type QuotaBucket = string

type Usable = 'yes' | 'no' | 'unknown'

interface QuotaSnapshot {
  bucket: QuotaBucket
  usable: Usable
  percentRemaining: number | null
  status: number | null            // 2 = interval blocked
  windowEndsAt: string | null      // ISO 8601
  windowEndsInSeconds: number | null
  weeklyPercentRemaining: number | null
  weeklyEndsAt: string | null
  fetchedAt: string                // ISO 8601
  source: 'api' | 'cache'
  warning?: string                 // e.g. percent below the configured floor
  error?: string                   // present iff usable === 'unknown'
}

class QuotaService extends Service {
  /** Cached read. Synchronous, never touches the network. */
  get(bucket?: QuotaBucket): QuotaSnapshot
  /** Forces a read; concurrent callers share one in-flight request. */
  refresh(bucket?: QuotaBucket): Promise<QuotaSnapshot>
  /** Next reset instant for a bucket, or null when unknown. */
  nextBoundary(bucket?: QuotaBucket): string | null
  /** Subscribe to state changes; returns a disposer. */
  onChange(cb: (snapshot: QuotaSnapshot) => void): () => void
}

// Cordis event, emitted only when a snapshot actually changes:
//   'quota/changed' (snapshot: QuotaSnapshot): void
```

**Tool `quota_status`** — parameters `{ bucket?: string }` (default from config, `'general'`), returning the snapshot and rendering as a compact text line, e.g.:

```
minimax-cn general: NOT USABLE (0% left, window resets in 57m at 05:00Z); weekly 100%
```

**Nothing in this surface may be spelled in a way that implies enforcement.** No `allow`, no `block`, no `canDispatch`.

## 5. Refresh strategy

1. **On activation:** one read, publish, then arm a single timer at `windowEndsAt + jitter` (default 10 s, ±5 s) so the refresh is detected seconds after it happens.
2. **At the boundary:** re-read, re-arm. One timer at a time, owned by the fiber.
3. **On demand:** `get()` returns the cache regardless of age, marking `source: 'cache'`; when the entry is older than `maxAgeSeconds` (default 120) it also schedules a background refresh. A tool call therefore never waits on HTTP.
4. **De-duplication:** concurrent `refresh()` callers share one in-flight request; a second timer is never armed while one is pending.
5. **Failure:** exponential backoff (5 s doubling to a 5 min cap) and `usable: 'unknown'`. **A failed read must never be reported as `no`** — see §7 for the mutation that enforces it.
6. **`usable` derivation:** `no` when `status === 2` or `percentRemaining === 0`; `yes` otherwise; `warning` set when `percentRemaining` is below `blockBelowPercent` (default 5) but above zero. Thresholds are configuration, not policy: the tool reports, the caller decides.

## 6. Configuration

`apiKey` (default `''` → env → `~/.mmx/config.json`), `baseUrl` (default the production endpoint), `bucket` (default `'general'`), `maxAgeSeconds` (120), `pollJitterSeconds` (10), `blockBelowPercent` (5), `requestTimeoutMs` (5000).

No `blockThreshold`/`softThreshold`: those names belonged to the deleted gate and would invite its return.

## 7. Testing

| Tier | What it proves |
|---|---|
| Unit | Response parsing — missing fields, an empty `model_remains`, an unknown bucket, a bucket present with zeroed counts; the `usable` derivation table; seconds/ISO conversion; backoff schedule |
| Contract | A fake fetcher typed to the internal shape; **a failed read yields `unknown` and never `no`**; a stale cache reports `source: 'cache'` |
| Harness (real Cordis) | The row mounts; `ctx.quota` is published; `quota/changed` fires on a real state change and not on an unchanged read; `quota_status` registers with the expected schema; `fiber.update()` and `dispose()` leave no pending timer (the child-fiber/timer-ownership rule from the companion project) |
| Build | `lib/index.js` imports no dsh package; the bundle's only runtime imports are its declared dependencies |

**Required mutation proofs** (each must fail a test, then be reverted):
1. make a failed read return `usable: 'no'` — the rule that protects a good model from a network blip;
2. remove the boundary re-arm — the behaviour that makes the whole design cheap;
3. report `source: 'api'` for a stale cache entry — the signal that tells a caller how fresh the answer is.

No test may touch the live network.

## 8. Risks and deferred work

- **The CLI is not shelled out to.** `mmx quota` stays a manual fallback, which avoids a subprocess/sandbox question and a second parsing path; if the HTTP route is down, the tool reports `unknown` and the operator runs the CLI.
- **The endpoint exposes counts and percentages, not a budget.** "How many requests remain" is derived, never authoritative — the tool must not imply precision it does not have.
- **Deferred, with hooks noted:** a `QuotaProvider` seam when a second source appears (OpenRouter credits, a local GPU queue); `ctx.credentials` for the key; a client UI row subscribing to `quota/changed`; injecting a refresh notice into a waiting agent through `agent.inject()`.

## 9. Open questions for review

1. **Tool name** — `quota_status` (generic, takes a `bucket`) or `mmx_quota` (obvious provider, narrower)?
2. **Bucket selection** — should the default read `'general'` specifically, or read every bucket and select by model name so a future MiniMax model routes correctly without a config change?
3. **Low-but-nonzero behaviour** — I propose `usable: 'yes'` with a `warning` below the configured floor, rather than `no`. Confirm, since a stricter reading would change how often the orchestrator switches away.
