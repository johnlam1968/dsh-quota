import type { BlockRecord, PlanStatus } from './types.js'
import { formatDuration, windowLabel } from './format.js'
import { rowFor } from './derive.js'
import type { DeriveSpec } from './derive.js'

/** Everything the announcement needs, with nothing it does not. */
export interface NoticeFacts {
  readonly provider: string
  readonly record: BlockRecord
  readonly status: PlanStatus
  readonly model: string
  readonly spec: DeriveSpec
}

/**
 * The noun phrase naming what reset.
 *
 * Built from the record's window rather than the current status: at wake time
 * every row reads healthy, so a snapshot cannot tell us which window expired.
 */
export function blockedPhrase(facts: NoticeFacts): string {
  return `the ${windowLabel(facts.record.window)} usage window`
}

/**
 * The one-line account carried in the message source.
 *
 * Rendered collapsed in the client, so it states what happened and nothing
 * else. It is written to fit well inside `CONTEXT_SUMMARY_MAX_CHARS` on its
 * own rather than relying on being truncated.
 */
export function noticeSummary(facts: NoticeFacts): string {
  const phrase = blockedPhrase(facts).replace(/^the /, '')
  return `${facts.provider} ${phrase} reset — blocked work may resume`
}

/**
 * How long the freshly reset window still has to run.
 *
 * Read from the window the record names, not from `nextResetAt`: nothing is
 * blocked by the time this message is sent, so "the next blocking boundary"
 * is always absent. The useful fact is the runway the agent now has.
 */
function runwayPhrase(facts: NoticeFacts): string | null {
  const row = rowFor(facts.status.rows, facts.model, facts.spec, facts.record.window)
  if (row === undefined || row.resetAt === null) return null
  return formatDuration(row.resetAt - facts.status.checkedAt)
}

/**
 * The announcement text.
 *
 * This message exists to wake an agent whose turn died on a quota refusal, so
 * it has three jobs and no fourth: say that the limit is gone, say what it
 * was, and make resuming the obvious next action. It must not scold, must not
 * apologise, and must not pretend to know what the interrupted work was — the
 * session log knows that, and the agent does too.
 */
export function noticeText(facts: NoticeFacts): string {
  const { provider, record, status } = facts
  const exhausted = formatDuration(status.checkedAt - record.since)
  const runway = runwayPhrase(facts)

  return (
    `Quota notice for ${provider}: ${blockedPhrase(facts)} has reset. `
    + `Your previous turn was refused with "${record.code} — ${record.message}" `
    + `after ${exhausted} of that window being exhausted`
    + (runway === null ? '.' : `, giving you ${runway} of fresh window before it fills again.`)
    + `\n\n`
    + `Your provider is reachable again. If the work you were doing was cut short by that limit, `
    + `pick it up exactly where it stopped — the interrupted turn and everything before it are still `
    + `in this conversation. If it was not, carry on with whatever you were asked to do next. `
    + `Use the quota status tool if you want the current numbers before committing to a long run.`
  )
}
