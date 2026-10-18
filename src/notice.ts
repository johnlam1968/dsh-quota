import type { PlanStatus, QuotaWindow } from './types.js'
import { formatDuration, windowLabel } from './format.js'
import { rowFor } from './derive.js'
import type { DeriveSpec } from './derive.js'

/** Everything the announcement needs, with nothing it does not. */
export interface NoticeFacts {
  readonly provider: string
  /**
   * Which window was the one that recovered.
   *
   * This is the ONLY fact about the outage that survives. At wake time every
   * row reads healthy, so nothing in the current status can say which window
   * expired; the edge that produced this message is what carries it.
   */
  readonly window: QuotaWindow
  readonly status: PlanStatus
  readonly model: string
  readonly spec: DeriveSpec
}

/**
 * The noun phrase naming what reset.
 *
 * Built from the edge's window rather than the current status: at wake time
 * every row reads healthy, so a snapshot cannot tell us which window expired.
 */
function blockedPhrase(facts: NoticeFacts): string {
  return `the ${windowLabel(facts.window)} usage window`
}

/**
 * How long the freshly reset window still has to run.
 *
 * Read from the window the edge names, not from `nextResetAt`: nothing is
 * blocked by the time this message is sent, so "the next blocking boundary"
 * is always absent. The useful fact is the runway the agent now has.
 */
function runwayPhrase(facts: NoticeFacts): string | null {
  const row = rowFor(facts.status.rows, facts.model, facts.spec, facts.window)
  if (row === undefined || row.resetAt === null) return null
  return formatDuration(row.resetAt - facts.status.checkedAt)
}

/**
 * The announcement text.
 *
 * This message exists to wake an agent whose turn died on a quota refusal, so
 * it has two jobs and no third: say the window is usable again, and make
 * resuming the obvious next action.
 *
 * It deliberately does NOT claim the session's last turn was refused, name a
 * provider error code, or quote how long the window was exhausted. The row
 * detects the outage by PROBING, so it never saw any refusal — an earlier
 * version synthesised all three and told the agent something untrue. The
 * observation and the guess must not be confused; if a per-session record is
 * ever wanted, it has to come from an observed error, not from a probe.
 */
export function noticeText(facts: NoticeFacts): string {
  const { provider } = facts
  const runway = runwayPhrase(facts)

  return (
    `Quota notice for ${provider}: ${blockedPhrase(facts)} was exhausted and has reset`
    + (runway === null ? '.' : `, giving you ${runway} of fresh window before it fills again.`)
    + `\n\n`
    + `Your provider is reachable again. If work you were doing was cut short by that limit, `
    + `pick it up exactly where it stopped — the interrupted turn and everything before it are still `
    + `in this conversation. If nothing was interrupted, carry on with whatever you were asked to do next. `
    + `Use the quota status tool if you want the current numbers before committing to a long run.`
  )
}
