// Bundle the row and assert its runtime dependency surface.
//
// The assertion is an ALLOWLIST, never a blanket ban: a new legitimate runtime
// import should be a deliberate edit here rather than something the build
// silently tolerates. Everything not on this list is meant to be `import type`
// and must not survive into the bundle.
//
//   node scripts/build.mjs

import { build } from 'esbuild'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Packages the emitted bundle is allowed to import at runtime.
 *
 *   cordis      `extends Service` is a real base class, not a type.
 *   dsh-tools   defineTool compiles the parameter DSL and validates arguments.
 *   schemastery the Config schema is evaluated when the module loads.
 *
 * `@deepseek-ai/dsh-llm` is deliberately absent: the announcement is built
 * without it. It is imported for TYPES only, which never survive bundling.
 */
const ALLOWED = new Set([
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/schemastery',
])

mkdirSync(resolve(root, 'lib'), { recursive: true })

await build({
  entryPoints: [resolve(root, 'src/index.ts')],
  outfile: resolve(root, 'lib/index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  metafile: true,
  write: true,
  // Resolve these from the HOST at runtime. Bundling them would both bloat the
  // output and fork the copy of Cordis the running plugin tree uses.
  external: [...ALLOWED],
})

// Read the emitted specifiers rather than the metafile inputs: inputs are
// node_modules-relative paths, so a prefix match on them silently finds
// nothing and the assertion would pass on a bundle that inlined everything.
const emitted = readFileSync(resolve(root, 'lib/index.js'), 'utf8')
const imported = new Set()
for (const match of emitted.matchAll(/from\s*["'](@deepseek-ai\/[\w-]+)["']/g)) {
  imported.add(match[1])
}

const smuggled = [...imported].filter(specifier => !ALLOWED.has(specifier))
if (smuggled.length > 0) {
  console.error('dsh-quota: the bundle imports packages outside the allowlist.')
  console.error(`  allowed: ${[...ALLOWED].join(', ')}`)
  console.error(`  found:   ${smuggled.join(', ')}`)
  console.error('  If one of these genuinely belongs at runtime, add it to ALLOWED')
  console.error('  in scripts/build.mjs — deliberately, with a reason in the comment.')
  process.exit(1)
}

console.log(`dsh-quota: bundled lib/index.js (runtime imports: ${[...imported].join(', ') || 'none'})`)
