// Mutation proof runner.
//
// For each declared mutation: apply it, assert the suite goes RED, then revert
// byte-identically with `git checkout`. A mutation that leaves the suite green
// means the test it was supposed to kill does not actually cover that
// behaviour — which is worse than no test, because it reads as coverage.
//
//   node scripts/mutate.mjs
//
// Exits non-zero if any mutation fails to break its suite, or if any revert
// leaves the tree dirty.

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
    file: 'src/block.ts',
    test: 'tests/unit/block.test.ts',
    find: '    pattern.lastIndex = 0\n',
    replace: '',
    claim: 'a stateful /g pattern stays stable across calls',
  },
]

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' })

function runSuite(test) {
  try {
    execFileSync('pnpm', ['exec', 'vitest', 'run', test], { stdio: 'pipe', encoding: 'utf8' })
    return { green: true }
  } catch (error) {
    const out = `${error.stdout ?? ''}${error.stderr ?? ''}`
    return { green: false, detail: (out.match(/Tests\s+.*/) ?? [''])[0].trim() }
  }
}

const before = runSuite('tests/unit')
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
    git('checkout', '--', m.file)
    continue
  }

  const result = runSuite(m.test)
  git('checkout', '--', m.file)

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

const dirty = git('status', '--porcelain').trim()
if (dirty !== '') {
  console.error(`\nworktree not clean after reverting:\n${dirty}`)
  process.exit(1)
}

console.log(`\n${MUTATIONS.length - survived}/${MUTATIONS.length} mutations killed`)
process.exit(survived === 0 ? 0 : 1)
