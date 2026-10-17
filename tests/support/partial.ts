/**
 * Schemastery types a schema's input as its output, so a call site that means
 * "partial row config" — every field has a schema default, so the validator
 * fills the rest in — must say so with one named cast. Every test that builds a
 * config from a partial imports this rather than carrying its own copy.
 */
import type { QuotaConfig } from '../../src/config.js'

export const partial = (value: Record<string, unknown>): QuotaConfig =>
  value as unknown as QuotaConfig
