/** The subset of `LlmFailure` this module reads. Structurally compatible. */
export interface FailureLike {
    readonly message: string;
    readonly code: string;
    readonly status?: number;
}
/**
 * Provider-neutral codes the harness assigns to quota exhaustion.
 *
 * These are already normalised by the adapter before a failure reaches us.
 * The pi-ai adapter runs `classifyPiAiError(message)` over the provider's own
 * wording and maps it through `isQuotaExceededError`, so MiniMax's raw
 * `2056 usage limit exceeded` arrives as `code: 'QUOTA'` — the raw vendor
 * number is only ever in the message. Matching the normalised code is
 * therefore both cheaper and far more stable than matching provider prose,
 * which is free to drift. The configured patterns remain as the net for
 * anything the adapter did not classify.
 *
 * See `QUOTA_EXCEEDED_CODE` / `ACCOUNT_QUOTA_EXCEEDED_CODE` in dsh-llm.
 */
export declare const HARNESS_QUOTA_CODES: ReadonlySet<string>;
/**
 * Whether a provider failure is the quota block we care about.
 *
 * Three sources, in decreasing order of stability: the harness-assigned code
 * (exact match, above), then a configured pattern net over all three failure
 * fields for providers or builds the adapter did not classify.
 *
 * Every field is attacker-influenced text, so this is best-effort detection,
 * not an authority: a miss costs a session its reset wake, and a false
 * positive costs one spurious announcement.
 */
export declare function matchesBlock(failure: FailureLike, patterns: readonly RegExp[]): boolean;
