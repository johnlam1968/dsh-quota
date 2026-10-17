import type { PlanStatus, QuotaWindow } from './types.js'
import { effectiveRows, isUsable } from './derive.js'
import type { DeriveSpec } from './derive.js'

/** How a countdown is spoken. Deterministic: no clock, no locale. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'an unknown time'
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`

  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`

  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 24) return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`

  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`
}

/** The window name as a reader sees it. */
export function windowLabel(window: QuotaWindow): string {
  return window === '5h' ? '5-hour' : 'weekly'
}

/** How each window reads to a person, for one line of prose. */
function windowPhrase(status: PlanStatus, model: string, spec: DeriveSpec): string | null {
  const parts: string[] = []
  for (const row of effectiveRows(status.rows, model, spec)) {
    const label = windowLabel(row.window)
    if (row.blocked) {
      parts.push(
        row.resetAt === null
          ? `${label} window exhausted`
          : `${label} window exhausted, resets ${formatDuration(row.resetAt - status.checkedAt)}`,
      )
      continue
    }
    const pct = row.remainingPercent
    parts.push(
      pct === null
        ? `${label} window open (remaining unreported)`
        : `${label} window ${pct}% remaining`,
    )
  }
  return parts.length === 0 ? null : parts.join('; ')
}

/**
 * One line of quota state for the system prompt, or '' when there is nothing
 * to report.
 *
 * **Always on whenever we have a reading.** A session starts with no memory of
 * the account, so its status has to be in context from the first turn — not
 * only once the budget is nearly gone. An agent that learns about the ceiling
 * when it hits it is an agent that already wasted the window.
 *
 * Silent in exactly two cases: never read yet, and a read that failed. Both are
 * silence rather than a guess, because saying "exhausted" after a failed HTTP
 * request would halt an agent over nothing.
 *
 * What is graded is the WORDING, not the presence: blocked says so plainly, a
 * low window says to pace, a comfortable one just states the numbers.
 *
 * `usable` is computed by the same `derive` the tool and the wake edge use, so
 * the prompt can never contradict them.
 */
export function renderQuotaStatus(
  status: PlanStatus | null,
  model: string,
  spec: DeriveSpec,
  lowWaterMarkPercent: number,
): string {
  // A plan we have never read successfully has nothing to report. Saying
  // "exhausted" here would halt an agent over a failed HTTP request.
  if (status === null || status.error !== null) return ''

  const usable = isUsable(status, model, spec)
  const phrase = windowPhrase(status, model, spec)
  if (phrase === null) return ''

  if (!usable) {
    return (
      `<provider-quota>${phrase}. `
      + `Requests to this provider are being refused until it resets; `
      + `this is a quota limit, not a fault. Do not retry in a loop — `
      + `work on something else, or wait for the reset.</provider-quota>`
    )
  }

  const low = effectiveRows(status.rows, model, spec).some(
    row => !row.blocked && row.remainingPercent !== null && row.remainingPercent <= lowWaterMarkPercent,
  )

  return low
    ? (
        `<provider-quota>${phrase}. `
        + `Usage is low enough to be worth pacing; `
        + `save the remaining budget for work that needs this model.</provider-quota>`
      )
    : `<provider-quota>${phrase}. Requests to this provider are being accepted.</provider-quota>`
}
