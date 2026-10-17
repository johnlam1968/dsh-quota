import { randomUUID } from 'node:crypto'
import type { ContentBlock, ContextFormed, MessageId, UserMessage } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A quota reset announcement delivered into a session. */
    'quota-notice': { kind: 'quota-notice' } & ContextFormed
  }
}

/**
 * The producer identity carried by an announcement.
 *
 * Declared separately so `createQuotaNotice` can return a message whose
 * `source` is known, rather than the whole `MessageSource` union — which
 * includes `{ kind: 'user' }`, a variant with no `form`. Without this, every
 * consumer has to narrow a union to read a field the producer just set.
 */
export interface QuotaNoticeSource {
  readonly kind: 'quota-notice'
  readonly form: 'notice'
  readonly summary: string
}

/** An announcement message, narrowed to the source it always carries. */
export type QuotaNotice = UserMessage & { readonly source: QuotaNoticeSource }

/**
 * Build the announcement message without a runtime import of dsh-llm.
 *
 * `createUserMessage` is three lines — `deepFreeze(structuredClone({ ...input,
 * role: 'user', id: brandString(randomUUID()) }))` — and it would be the only
 * reason this package took a second runtime dsh dependency. Reproducing it
 * costs one brand cast and keeps that dependency at test-only, where it is
 * more valuable anyway: the unit test builds the same message with the real
 * constructor and asserts the two are structurally identical, so this cannot
 * silently drift from the sanctioned shape.
 *
 * The cast is safe and local. `MessageId` is a compile-time brand over a
 * string, and the value passed is a `randomUUID()` this function just
 * generated — not external input being asserted into a shape.
 */
export function createQuotaNotice(text: string, summary: string): QuotaNotice {
  const block: ContentBlock = Object.freeze({ type: 'text', text })
  const content: readonly ContentBlock[] = Object.freeze([block])

  return Object.freeze({
    role: 'user',
    id: randomUUID() as MessageId,
    content,
    source: Object.freeze({ kind: 'quota-notice', form: 'notice', summary }),
  }) as QuotaNotice
}
