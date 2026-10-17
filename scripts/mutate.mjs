// Mutation proof runner.
//
// For each declared mutation: apply it, assert the suite goes RED, then restore
// the original bytes from memory. A mutation that leaves the suite green
// means the test it was supposed to kill does not actually cover that
// behaviour — which is worse than no test, because it reads as coverage.
//
//   node scripts/mutate.mjs
//
// The revert is an in-memory write-back rather than a git checkout, so it is
// byte-identical by construction and works on an untracked file.
//
// Exits non-zero if any mutation fails to break its suite, or if any revert
// leaves a tracked file dirty.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const MUTATIONS = [
  {
    file: 'src/probe.ts',
    test: 'tests/unit/probe.test.ts',
    find: 'blocked: status === STATUS_BLOCKED || pct === 0,',
    replace: 'blocked: status === STATUS_BLOCKED,',
    claim: 'zero remaining percent blocks even when status disagrees',
  },
  {
    file: 'src/probe.ts',
    test: 'tests/unit/probe.test.ts',
    find: '  if (!sawEntry) {',
    replace: '  if (false) {',
    claim: 'an absent account entry fails rather than reading as healthy',
  },
  {
    file: 'src/derive.ts',
    test: 'tests/unit/derive.test.ts',
    find: "window => rowFor(rows, model, spec, window)?.blocked !== true,",
    replace: "window => rowFor(rows, model, spec, window)?.blocked === true,",
    claim: 'usable is the negation of blocked',
  },
  {
    file: 'src/derive.ts',
    test: 'tests/unit/derive.test.ts',
    find: "return isVideoModel(model, spec) ? ['weekly'] : ['5h', 'weekly']",
    replace: "return ['5h', 'weekly']",
    claim: 'video models are exempt from the 5-hour window',
  },
  {
    file: 'src/derive.ts',
    test: 'tests/unit/derive.test.ts',
    find: `  return (\n    rows.find(row => row.entry === model && row.window === window) ??\n    rows.find(row => row.entry === spec.entry && row.window === window)\n  )`,
    replace: `  return rows.find(row => row.entry === spec.entry && row.window === window)`,
    claim: "a model's own row outranks the account-wide row",
  },
  {
    file: 'src/schedule.ts',
    test: 'tests/unit/schedule.test.ts',
    find: 'const sliced = until / cfg.divisor',
    replace: 'const sliced = until',
    claim: 'the remaining wait is divided into even slices',
  },
  {
    file: 'src/schedule.ts',
    test: 'tests/unit/schedule.test.ts',
    find: '  if (status.error !== null) {',
    replace: '  if (false) {',
    claim: 'a failed read backs off instead of using provider state',
  },
  {
    file: 'src/schedule.ts',
    test: 'tests/unit/schedule.test.ts',
    find: 'const clamped = Math.min(Math.max(sliced, cfg.minIntervalMs), cfg.maxIntervalMs)',
    replace: 'const clamped = sliced',
    claim: 'slices are clamped into the configured interval bounds',
  },
  {
    file: 'src/format.ts',
    test: 'tests/unit/format.test.ts',
    find: '  if (!usable) {',
    replace: '  if (false) {',
    claim: 'a blocked plan always says so',
  },
  {
    file: 'src/format.ts',
    test: 'tests/unit/format.test.ts',
    find: '  if (!low || phrase === null) return \'\'',
    replace: '  if (phrase === null) return \'\'',
    claim: 'low usage speaks up, healthy usage stays silent',
  },
  {
    file: 'src/format.ts',
    test: 'tests/unit/format.test.ts',
    find: 'work on something else, or wait for the reset.</provider-quota>`',
    replace: '</provider-quota>`',
    claim: 'the blocked line tells the agent not to retry in a loop',
  },
  {
    file: 'src/notice.ts',
    test: 'tests/unit/notice.test.ts',
    find: '  return `the ${windowLabel(facts.record.window)} usage window`',
    replace: "  return `the ${windowLabel(rowFor(facts.status.rows, facts.model, facts.spec, 'weekly')?.blocked === true ? 'weekly' : '5h')} usage window`",
    claim: 'the reset window comes from the record, not a now-healthy status',
  },
  {
    file: 'src/notice.ts',
    test: 'tests/unit/notice.test.ts',
    find: '${record.code} — ${record.message}',
    replace: 'a provider-side usage limit',
    claim: 'the announcement quotes what actually blocked the turn',
  },
  {
    file: 'src/state.ts',
    test: 'tests/unit/state.test.ts',
    find: '      state: { status: prev.status, blockedAgents: prev.blockedAgents, errorStreak: prev.errorStreak + 1 },',
    replace: '      state: { status: next, blockedAgents: prev.blockedAgents, errorStreak: prev.errorStreak + 1 },',
    claim: 'the last GOOD status survives a failed read',
  },
  {
    file: 'src/state.ts',
    test: 'tests/unit/state.test.ts',
    find: '    if (!usableNow) {\n      blocked.set(sessionId, record)\n      continue\n    }',
    replace: '    if (false) {\n      blocked.set(sessionId, record)\n      continue\n    }',
    claim: 'a still-blocked session keeps its record',
  },
  {
    file: 'src/state.ts',
    test: 'tests/unit/state.test.ts',
    find: '    const wasUsable = wasReadable\n      ? deriveUsable(prev.status?.rows ?? [], record.model, spec)\n      : true',
    replace: '    const wasUsable = wasReadable\n      ? deriveUsable(next.rows, record.model, spec)\n      : true',
    claim: 'the edge compares the previous reading against the new one',
  },
  {
    file: 'src/state.ts',
    test: 'tests/unit/state.test.ts',
    find: '    if (!wasUsable) {',
    replace: '    if (true) {',
    claim: 'only a real unusable -> usable transition speaks',
  },
  {
    file: 'src/config.ts',
    test: 'tests/unit/config.test.ts',
    find: "  maxIntervalMs: z.natural().min(1).default(900_000),",
    replace: "  maxIntervalMs: z.natural().min(1).default(15_000),",
    claim: 'the interval ceiling defaults above the floor',
  },
  {
    file: 'src/config.ts',
    test: 'tests/unit/config.test.ts',
    find: "    throw new Error(`dsh-quota: endpoint is not a URL: ${JSON.stringify(config.endpoint)}`)",
    replace: '    void 0',
    claim: 'a non-URL endpoint fails the load',
  },
  {
    file: 'src/block.ts',
    test: 'tests/unit/block.test.ts',
    find: '  if (HARNESS_QUOTA_CODES.has(failure.code)) return true',
    replace: '  // removed',
    claim: 'the harness-normalised quota code matches with no patterns',
  },
  {
    file: 'src/block.ts',
    test: 'tests/unit/block.test.ts',
    find: "export const HARNESS_QUOTA_CODES: ReadonlySet<string> = new Set(['QUOTA', 'ACCOUNT_QUOTA'])",
    replace: "export const HARNESS_QUOTA_CODES: ReadonlySet<string> = new Set(['QUOTA'])",
    claim: 'both harness quota codes are recognised',
  },
  {
    file: 'src/message.ts',
    test: 'tests/unit/message.test.ts',
    find: '  const content: readonly ContentBlock[] = Object.freeze([block])',
    replace: '  const content: readonly ContentBlock[] = [block]',
    claim: 'the content array is frozen like the real constructor\'s',
  },
  {
    file: 'src/message.ts',
    test: 'tests/unit/message.test.ts',
    find: "    source: Object.freeze({ kind: 'quota-notice', form: 'notice', summary }),",
    replace: "    source: Object.freeze({ kind: 'notice', form: 'notice', summary }),",
    claim: 'the message source matches the sanctioned shape',
  },
  {
    file: 'src/probe.ts',
    test: 'tests/unit/probe.test.ts',
    find: '      blocked: weeklyPct === 0,',
    replace: '      blocked: weeklyPct === 99,',
    claim: 'the weekly window blocks on zero percent',
  },
  {
    file: 'src/probe.ts',
    test: 'tests/unit/probe.test.ts',
    find: "      blocked: narrowNumber(raw['current_interval_status']) === STATUS_EXHAUSTED || pct === 0,",
    replace: '      blocked: pct === 0,',
    claim: 'the 5-hour window blocks on the status marker or zero percent',
  },
  {
    file: 'src/probe.ts',
    test: 'tests/unit/probe.test.ts',
    find: "      resetAt: narrowCountdown(raw['weekly_remains_time'], now),",
    replace: '      resetAt: null,',
    claim: 'the weekly countdown becomes an absolute instant',
  },
  {
    file: 'src/derive.ts',
    test: 'tests/unit/derive.test.ts',
    find: '      : rows.find(row => row.entry === video && row.window === window)) ??',
    replace: '      undefined) ??',
    claim: "a video model's own entry outranks the account-wide row",
  },
  {
    file: 'src/block.ts',
    test: 'tests/unit/block.test.ts',
    find: '    pattern.lastIndex = 0\n',
    replace: '',
    claim: 'a stateful /g pattern stays stable across calls',
  },
  // --- Task 9a: the contract tier -----------------------------------------
  // These kill the wiring in `src/index.ts`, which no unit test can reach: the
  // listeners are reached only through a real dispatch, and a case that called
  // one directly would still pass with the registration deleted.
  {
    file: 'src/index.ts',
    test: 'tests/contract/wake.test.ts',
    find: `    this.ctx.on('agent/error', ({ agent, error }) => {
      const failure = narrowFailure(error)
      // No provider on this channel, so only the current route can be
      // checked. A session on another route cannot have been blocked by this
      // plan's quota in the first place.
      this.recordBlock(agent.id, failure, agent.options.provider)
    })

`,
    replace: '',
    claim: 'a thrown failure wakes its session — the agent/error channel is observed at all',
  },
  {
    file: 'src/index.ts',
    test: 'tests/contract/wake.test.ts',
    find: '      return await next()',
    replace: '      return undefined',
    claim: 'the request-error waterfall is delegated, so the refusal stays retryable',
  },
  {
    file: 'src/index.ts',
    test: 'tests/contract/wake.test.ts',
    find: '      this.recordBlock(agent.id, failure, agent.options.provider)',
    replace: '      this.recordBlock(agent.id, failure, undefined)',
    claim: 'the agent/error channel filters on the agent\'s own route',
  },
  {
    file: 'src/index.ts',
    test: 'tests/contract/wake.test.ts',
    find: '    if (!matchesBlock(failure, this.plan.blockPatterns)) return\n',
    replace: '',
    claim: 'a rate limit is not an exhausted window, and records nothing',
  },
  {
    file: 'src/index.ts',
    test: 'tests/contract/wake.test.ts',
    find: "      return { code: f['code'], message: f['message'], ...(status === undefined ? {} : { status }) }",
    replace: "      return { code: 'UNKNOWN', message: String(error) }",
    claim: 'a thrown LlmError keeps its own normalised failure',
  },
  {
    file: 'src/index.ts',
    test: 'tests/contract/wake.test.ts',
    find: '      this.recordBlock(payload.agent.id, payload.failure, payload.provider)',
    replace: '      this.recordBlock(payload.agent.id, payload.failure, payload.agent.options.provider)',
    claim: 'the in-band channel judges a refusal by the route that served it',
  },
  {
    file: 'src/index.ts',
    test: 'tests/contract/wake.test.ts',
    find: `    const agent = this.ctx.agents.get(notice.sessionId)
    if (agent === undefined) return`,
    replace: '    const agent = this.ctx.agents.get(notice.sessionId)',
    claim: 'a session gone by the time the reset lands costs the row no tick',
  },
  {
    file: 'src/index.ts',
    test: 'tests/contract/wake.test.ts',
    find: `        return window
      }`,
    replace: `        return 'weekly'
      }`,
    claim: 'the record names the window that actually gated this model',
  },
  {
    file: 'src/index.ts',
    test: 'tests/contract/wake.test.ts',
    find: `    // Read once immediately: the first status should not wait out a delay.
    void this.tick().then(
      schedule => arm(schedule.delayMs),`,
    replace: `    void this.tick().then(
      schedule => arm(schedule.delayMs * 2),`,
    claim: 'the first wake is armed at the boundary the provider reported',
  },
]

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' })

function runSuite(...tests) {
  try {
    execFileSync('pnpm', ['exec', 'vitest', 'run', ...tests], { stdio: 'pipe', encoding: 'utf8' })
    return { green: true }
  } catch (error) {
    const out = `${error.stdout ?? ''}${error.stderr ?? ''}`
    return { green: false, detail: (out.match(/Tests\s+.*/) ?? [''])[0].trim() }
  }
}

// Every tier the runner mutates, not just the unit one: a mutation is only
// "killed" if its suite was green BEFORE it, and a contract suite that was
// already red would report every wiring mutation as a kill.
const before = runSuite('tests/unit', 'tests/harness', 'tests/contract')
if (!before.green) {
  console.error('FATAL: the suite is not green before mutating. Fix that first.')
  process.exit(1)
}
console.log('baseline: green\n')

let survived = 0
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, 'utf8')
  if (!original.includes(m.find)) {
    console.error(`SKIP  ${m.file}: pattern not found — the mutation is stale`)
    survived++
    continue
  }
  writeFileSync(m.file, original.replace(m.find, m.replace))
  const changed = readFileSync(m.file, 'utf8')
  if (changed === original) {
    console.error(`SKIP  ${m.file}: replacement was a no-op`)
    survived++
    writeFileSync(m.file, original)
    continue
  }

  const result = runSuite(m.test)
  writeFileSync(m.file, original)

  const reverted = readFileSync(m.file, 'utf8') === original
  if (!reverted) {
    console.error(`DIRTY ${m.file}: revert was not byte-identical`)
    survived++
  }

  if (result.green) {
    survived++
    console.log(`ALIVE ${m.file.padEnd(16)} ${m.claim}  <-- test does not cover this`)
  } else {
    console.log(`KILL  ${m.file.padEnd(16)} ${m.claim}  [${result.detail}]`)
  }
}

const dirty = git('status', '--porcelain', '--untracked-files=no').trim()
if (dirty !== '') {
  console.error(`\nworktree not clean after reverting:\n${dirty}`)
  process.exit(1)
}

console.log(`\n${MUTATIONS.length - survived}/${MUTATIONS.length} mutations killed`)
process.exit(survived === 0 ? 0 : 1)
