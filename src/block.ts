/** The subset of `LlmFailure` this module reads. Structurally compatible. */
export interface FailureLike {
  readonly message: string
  readonly code: string
  readonly status?: number
}

/**
 * Whether a provider failure is the quota block we care about.
 *
 * The provider's own numeric code is not a provider-neutral `LlmFailure.code`
 * — a specific vendor's usage-limit code reaches us inside `message`, and
 * sometimes as an HTTP `status`. So the haystack is all three fields and the
 * patterns are deployment configuration, because the exact wording is the
 * thing most likely to drift.
 *
 * Every field is attacker-influenced text, so this is best-effort detection,
 * not an authority: a miss costs a session its reset wake, and a false
 * positive costs one spurious announcement.
 */
export function matchesBlock(failure: FailureLike, patterns: readonly RegExp[]): boolean {
  if (patterns.length === 0) return false
  const haystack = `${failure.code} ${failure.status ?? ''} ${failure.message}`
  return patterns.some(pattern => {
    // A /g or /y regex carries lastIndex between calls and would alternate
    // match/no-match on identical input. Reset it or the detection is flaky.
    pattern.lastIndex = 0
    return pattern.test(haystack)
  })
}
