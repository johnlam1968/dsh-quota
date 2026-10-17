# Live response shape — measured 2026-10-17

One read of `GET https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains`
(region `cn`, credential from `~/.mmx/config.json`). Reproduce with
`node scripts/live-probe.mjs`. This settles the open question the conservative
`derive` had been written around.

## Shape

```
{ model_remains: [ … ], base_resp: { status_code: 0, status_msg: "success" } }
```

**`model_remains` holds TWO entries**, `model_name: "general"` and
`model_name: "video"`. Each carries both windows:

| interval (5h) | weekly |
|---|---|
| `current_interval_status` | `current_weekly_status` |
| `current_interval_remaining_percent` | `current_weekly_remaining_percent` |
| `current_interval_total_count` | `current_weekly_total_count` |
| `current_interval_usage_count` | `current_weekly_usage_count` |
| `remains_time` | `weekly_remains_time` |
| `start_time` / `end_time` | `weekly_start_time` / `weekly_end_time` |

So the weekly window is **not** a separate endpoint and **not** a different
entry — it is a parallel field family on every entry. That closes the open item.

## The trap

Observed values at probe time:

```
general: interval status=1 pct=46  |  WEEKLY STATUS=3  pct=100
video:   interval status=1 pct=100 |  weekly  status=1  pct=100
```

**`current_weekly_status = 3` while `current_weekly_remaining_percent = 100`.**
The status vocabulary is therefore NOT shared between the two windows: `1` is
healthy for both, but weekly is sitting on `3` with a full allowance.

Consequence — and this is the whole reason the block rule differs per window:

- **`5h` blocked = `status === 2 || pct === 0`.** `2` is the marker the
  reference probe script uses for the interval, and `current_interval_status`
  uses the same vocabulary as the interval.
- **`weekly` blocked = `pct === 0` ONLY.** Status is read and kept for
  diagnostics but never blocks on its own, because `3` cannot be mapped to
  blocked without actually hitting the wall.

Getting this wrong in the permissive direction (status blocks on its own) would
halt every session for no reason. Getting it wrong in the strict direction
(`pct` only, everywhere) risks missing an interval block — which is why the
interval keeps the status disjunct.

## Why this is safe even when we cannot tell

The probe is a **predictor**; the `2056` refusal is the **ground truth**. A
session is only ever *recorded* as blocked by an actual provider failure. The
probe's only load-bearing job is detecting the **recovery** — and
`remaining_percent > 0` reads as recovered under either rule.

So an unrecognised weekly status can delay a wake. It cannot fabricate one.

## Count fields are not a budget

```
video: total_count=3 usage_count=3, remaining_percent=100
```

Usage equal to total while the percent reads 100 means the counts are not a
limit pair — likely an unlimited tier. They are not used for blocking.

## Still unknown

What `current_weekly_status = 3` means. Not resolvable without hitting the wall.
If a wake is ever missed, that value is the first thing to inspect, and it is
already parsed and carried on the row.
