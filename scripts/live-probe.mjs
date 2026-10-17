// One live read of the quota endpoint, through the row's OWN parser.
//
// This is a diagnostic, not a test: it answers what the real response looks
// like, which is the one fact the unit tests could only guess. The key is read
// from the same config the reference probe script uses and never printed, never
// placed in argv, and never logged.
//
//   node scripts/live-probe.mjs

import { readFileSync } from 'node:fs'
// Node 25 strips types natively, so the parser under test is the source module
// itself — the same code the bundle is built from, not a re-implementation.
const { classifyQuota } = await import('../src/probe.ts')

const configPath = process.env['MINIMAX_CONFIG'] ?? `${process.env.HOME}/.mmx/config.json`
const cfg = JSON.parse(readFileSync(configPath, 'utf8'))
const key = String(cfg.api_key ?? '')
if (key.length === 0) {
  console.error(`no api_key in ${configPath}`)
  process.exit(1)
}

// Region drives the host: `cn` means api.minimaxi.com, anything else the .io host.
const endpoint = process.env['MINIMAX_ENDPOINT']
  ?? (cfg.region === 'cn'
    ? 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains'
    : 'https://api.minimax.io/v1/api/openplatform/coding_plan/remains')

console.log(`endpoint: ${endpoint}`)
console.log(`region:   ${cfg.region}`)

const response = await fetch(endpoint, {
  headers: { authorization: `Bearer ${key}` },
  signal: AbortSignal.timeout(15000),
})
console.log(`HTTP:     ${response.status} ${response.statusText}`)

const body = await response.text()
const parsed = JSON.parse(body)

// Shape summary FIRST, before interpretation, so a surprise is visible as a
// surprise rather than silently narrowed into "unreadable".
const topKeys = parsed && typeof parsed === 'object' ? Object.keys(parsed) : []
console.log(`top-level keys: ${JSON.stringify(topKeys)}`)
if (Array.isArray(parsed.model_remains)) {
  console.log(`model_remains entries: ${parsed.model_remains.length}`)
  for (const entry of parsed.model_remains) {
    if (entry && typeof entry === 'object') {
      console.log(`  model_name=${JSON.stringify(entry.model_name)} keys=${JSON.stringify(Object.keys(entry))}`)
    } else {
      console.log(`  (non-object entry: ${typeof entry})`)
    }
  }
} else {
  console.log(`model_remains: ${JSON.stringify(parsed.model_remains)} (not an array)`)
}

const now = Date.now()
const status = classifyQuota(body, now, { provider: 'minimax-cn', entry: 'general' })

console.log('\n--- classifyQuota ---')
console.log(`error:   ${status.error ?? '(none)'}`)
console.log(`rows:    ${status.rows.length}`)
for (const row of status.rows) {
  console.log(`  entry=${row.entry} window=${row.window} blocked=${row.blocked} ` +
              `pct=${row.remainingPercent} resetIn=${row.resetAt === null ? 'n/a' : `${(row.resetAt - now) / 1000}s`}`)
}
