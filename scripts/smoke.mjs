// Smoke test against the BUILT artifact.
//
// The unit and contract tiers exercise src/. This loads lib/index.js — the file
// the Loader will actually resolve — mounts it on a real Context, and drives a
// fake session through a route change to prove the subscription attaches and
// detaches.
//
//   node scripts/smoke.mjs

import { Context } from '@deepseek-ai/cordis'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const QuotaService = require('../lib/index.js').default

const config = {
  provider: 'minimax-cn',
  entry: 'general',
  endpoint: 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains',
  authEnv: 'DSH_QUOTA_SMOKE_KEY',
  requestTimeoutMs: 15000,
  readAttempts: 3,
  videoModelPatterns: [],
  blockPatterns: ['usage limit exceeded', '\\b2056\\b'],
  lowWaterMarkPercent: 20,
  schedule: {
    divisor: 4, minIntervalMs: 15000, maxIntervalMs: 900000, skewMs: 30000,
    baseBackoffMs: 1000, maxBackoffMs: 300000, jitterRatio: 0.1,
  },
  markerPath: '',
}

const contexts = []
const tools = []
let lastDefinition = null
const systemPrompt = {
  context(def) { contexts.push(def.name); return () => { const i = contexts.indexOf(def.name); if (i !== -1) contexts.splice(i, 1) } },
}
const toolRegistry = {
  register(def) { tools.push(def.name); lastDefinition = def; return () => { const i = tools.indexOf(def.name); if (i !== -1) tools.splice(i, 1) } },
}
const delivered = []
const agent = {
  id: 'session-smoke',
  options: { provider: 'minimax-cn', model: 'MiniMax-M3' },
  status: 'idle',
  session: { requestContext: () => undefined },
  followup: (m) => delivered.push(m),
}

// A minimal agent-scoped context: records the row's session/event listener so
// the smoke can push a committed route through it.
let sessionEventListener = null
const agentCtx = {
  on(name, cb) { if (name === 'session/event') sessionEventListener = cb; return () => {} },
  systemPrompt,
  tools: toolRegistry,
}

const root = new Context()
root.provide('agents', { get: () => agent, list: () => [] })
root.provide('systemPrompt', systemPrompt)
root.provide('tools', toolRegistry)

const fiber = root.plugin(QuotaService, config)
await fiber

const ACTIVE = 2
if (fiber.state !== ACTIVE) {
  console.error(`FAIL  fiber is ${fiber.state}, expected ${ACTIVE} (2). 0 = PENDING: a seam was never provided.`)
  process.exit(1)
}
console.log(`PASS  mounted the built row, fiber ACTIVE`)

// Create the agent through the real event, as the runtime would.
root.emit('agent/created', { agent: { ...agent, ctx: agentCtx }, source: 'startup' })
if (sessionEventListener === null) {
  console.error('FAIL  the row did not subscribe to session/event on agent/created')
  process.exit(1)
}
console.log('PASS  subscribed to session/event for the created agent')

// COLD SESSION. `requestContext()` is undefined and NO event has fired yet —
// this is a session created for its first request. The row must fall back to
// `agent.options` (the source `onReset` already trusts) rather than leave the
// session blind for a whole turn. Asserted BEFORE any event is pushed, because
// after an event this is indistinguishable from the route-change case below.
if (!contexts.includes('quota-usage-status') || !tools.includes('quota_status')) {
  console.error(`FAIL  cold session was not subscribed at creation: contexts=${JSON.stringify(contexts)} tools=${JSON.stringify(tools)}`)
  process.exit(1)
}
console.log('PASS  cold session subscribed at creation, before any route event')

// And the fallback must not OVER-subscribe: an agent whose own options point
// somewhere else gets nothing until a route event says otherwise.
{
  const other = {
    id: 'session-other',
    options: { provider: 'deepseek-official', model: 'x' },
    status: 'idle',
    session: agent.session,
    followup() {},
  }
  const otherCtx = {
    on() { return () => {} },
    systemPrompt: { context() { contexts.push('LEAKED'); return () => {} } },
    tools: { register() { tools.push('LEAKED'); return () => {} } },
  }
  root.emit('agent/created', { agent: { ...other, ctx: otherCtx }, source: 'startup' })
  if (contexts.includes('LEAKED') || tools.includes('LEAKED')) {
    console.error('FAIL  a session on another provider was subscribed at creation')
    process.exit(1)
  }
}
console.log('PASS  a session on another provider is not subscribed at creation')

// Route change ONTO the watched provider.
sessionEventListener(agent.session, { type: 'request/context', data: { provider: 'minimax-cn', model: 'MiniMax-M3' } })
if (!contexts.includes('quota-usage-status') || !tools.includes('quota_status')) {
  console.error(`FAIL  after switching ONTO the provider: contexts=${JSON.stringify(contexts)} tools=${JSON.stringify(tools)}`)
  process.exit(1)
}
console.log('PASS  subscribed: prompt context + quota_status tool are registered')

// Route change AWAY from it.
sessionEventListener(agent.session, { type: 'request/context', data: { provider: 'deepseek-official', model: 'deepseek-flash' } })
if (contexts.length !== 0 || tools.length !== 0) {
  console.error(`FAIL  after switching AWAY: contexts=${JSON.stringify(contexts)} tools=${JSON.stringify(tools)} — should be empty`)
  process.exit(1)
}
console.log('PASS  unsubscribed on the switch away')

// And back again.
sessionEventListener(agent.session, { type: 'request/context', data: { provider: 'minimax-cn', model: 'MiniMax-M3' } })
if (!contexts.includes('quota-usage-status') || !tools.includes('quota_status')) {
  console.error('FAIL  switching back did not re-subscribe')
  process.exit(1)
}
console.log('PASS  re-subscribed on the switch back')

// The tool must answer through the same derivation the prompt uses.
const tool = lastDefinition
const payload = await tool.execute({}, { name: 'quota_status', arguments: {}, signal: new AbortController().signal, agent })
if (payload.known !== false || typeof payload.provider !== 'string' || Array.isArray(payload.windows) !== true) {
  console.error(`FAIL  tool payload has the wrong shape: ${JSON.stringify(payload)}`)
  process.exit(1)
}
console.log(`PASS  tool executes and returns the declared shape: ${JSON.stringify(payload)}`)

await fiber.dispose()
if (fiber.state !== 4) { console.error(`FAIL  dispose left state ${fiber.state}`); process.exit(1) }
console.log('PASS  disposed cleanly')

console.log('\nsmoke: all checks passed against lib/index.js')
