// Drive the reset wake against the BUILT bundle, with a scripted endpoint.
//
// This is the one path no live run can exercise until the wall is actually hit:
// a healthy account never produces the signal. So the endpoint is scripted to
// report blocked, then usable, and the wake must arrive.
//
//   node scripts/wake-check.mjs

import { Context } from '@deepseek-ai/cordis'
import { createRequire } from 'node:module'

const QuotaService = createRequire(`${process.cwd()}/x.js`)('./lib/index.js').default

const base = {
  provider: 'minimax-cn',
  entry: 'general',
  endpoint: 'https://stub.quota.test/remains',
  authEnv: 'WAKE_CHECK_KEY',
  credentialFile: '',
}

// Without a credential every read fails before reaching the network, and the
// blocked→usable flip never happens — the first assertion would then pass
// vacuously. Set it up front.
process.env['WAKE_CHECK_KEY'] = 'stub'

// Three reads so the assertions can be order-explicit rather than a race on
// wall-clock: blocked, STILL blocked, then usable. Holding the blocked reading
// for two polls is what proves the wake comes from the FLIP and not merely
// from having read the endpoint at all.
const script = [
  { status: 2, pct: 0, remains: 3_600_000 },   // blocked, an hour out
  { status: 2, pct: 0, remains: 3_600_000 },   // still blocked
  { status: 1, pct: 100, remains: 3_600_000 }, // reset
]
let call = 0
globalThis.fetch = async () => {
  const read = script[Math.min(call++, script.length - 1)]
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      model_remains: [{
        model_name: 'general',
        current_interval_status: read.status,
        current_interval_remaining_percent: read.pct,
        remains_time: read.remains,
        current_weekly_remaining_percent: 100,
        weekly_remains_time: 7_600_000,
      }],
    }),
  }
}

const delivered = []
const mkAgent = (id, provider, model) => ({
  id, options: { provider, model }, status: 'idle',
  followup: (m) => delivered.push({ id, message: m }),
})
const onProvider = mkAgent('on-provider', 'minimax-cn', 'MiniMax-M3')
const onOther = mkAgent('on-other-provider', 'deepseek-official', 'deepseek-flash')
const running = mkAgent('on-provider-running', 'minimax-cn', 'MiniMax-M3')
running.status = 'running'

const root = new Context()
root.provide('agents', { get: () => undefined, list: () => [onProvider, onOther, running] })
root.provide('systemPrompt', { context: () => () => {} })
root.provide('tools', { register: () => () => {} })

const fiber = root.plugin(QuotaService, {
  ...base,
  requestTimeoutMs: 1000,
  readAttempts: 1,
  schedule: { divisor: 1, minIntervalMs: 150, maxIntervalMs: 150, skewMs: 10, baseBackoffMs: 100, maxBackoffMs: 100, jitterRatio: 0 },
})
await fiber

const fail = (label, ok) => { console.log(`${ok ? 'PASS ' : 'FAIL '} ${label}`); if (!ok) process.exitCode = 1 }

// Reads land at ~0ms, ~150ms and ~300ms. At 200ms two blocked readings have
// been seen and no flip has happened, so nothing should have been delivered.
await new Promise(r => setTimeout(r, 200))
fail('two blocked readings produce no wake', delivered.length === 0)

await new Promise(r => setTimeout(r, 400))
fail('the blocked → usable flip wakes the session on the provider', delivered.length === 1)
fail('…and only that session', delivered[0]?.id === 'on-provider')

const message = delivered[0]?.message
fail('the wake is a user-role message', message?.role === 'user')
fail('…carrying this row\'s own source kind', message?.source?.kind === 'quota-notice')
fail('…in notice form, with a one-line summary', message?.source?.form === 'notice' && typeof message?.source?.summary === 'string')
const text = message?.content?.[0]?.text ?? ''
fail('…announcing the reset', text.includes('usage window has reset'))
fail('…and pointing at resuming', text.includes('pick it up exactly where it stopped'))

await fiber.dispose()
console.log(process.exitCode ? '\nwake-check: FAILED' : '\nwake-check: all checks passed')
