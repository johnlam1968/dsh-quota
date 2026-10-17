/**
 * The one place a Context is assembled for this package's tests.
 *
 * This is a real Cordis runtime, not a plain-object mock: services resolve
 * through the context proxy and fibers own their effects exactly as they do
 * under `dsh web`. So `apply` fails here — not at deployment — when it reads a
 * service with `ctx.x` without declaring it in `inject`, assigns a service it
 * never provided, or registers something no effect owns.
 *
 * `agents` is provided by default because this row declares it in `inject`.
 * Without it the fiber stays PENDING, `apply` never runs, and every lifecycle
 * assertion here would pass vacuously — the exact class of defect the mount
 * gate exists to catch. A case needing a different seam passes it through
 * `extra`, which overrides the default.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Config } from '../../src/config.js'
import type { QuotaConfig } from '../../src/config.js'
import { partial } from '../support/partial.js'

/** A fully resolved row config: `Config` fills every field this leaves out. */
export const testConfig: QuotaConfig = Config(
  partial({
    provider: 'minimax-cn',
    endpoint: 'https://quota.test/remains',
    authEnv: 'DSH_QUOTA_TEST_KEY',
  }),
)

/** One announcement the row delivered, and the session that received it. */
export interface Delivery {
  readonly sessionId: string
  readonly message: { readonly source: { readonly kind: string; readonly summary?: string } }
}

export interface AgentsSeam {
  /** Every `followup` the row made, in order. */
  readonly delivered: readonly Delivery[]
  /** Register an agent the registry can resolve. */
  add(agent: FakeAgent): FakeAgent
  list(): Agent[]
}

export interface FakeAgent {
  readonly id: string
  readonly options: { provider?: string; model?: string }
  readonly status: 'idle' | 'running'
  /** Make `agents.get` stop resolving this id. */
  kill(): void
}

/**
 * A recording `agents` seam.
 *
 * `delivered` is the *live* set: an agent removed by `kill()` stops receiving
 * wakeups, so a case can prove the row handles a session that went away rather
 * than only the happy path.
 */
export function fakeAgents(): AgentsSeam & { register(id: string, agent: FakeAgent): void } {
  const delivered: Delivery[] = []
  const live = new Map<string, FakeAgent>()

  const seam = {
    delivered,
    add(agent: FakeAgent): FakeAgent {
      live.set(agent.id, agent)
      return agent
    },
    register(id: string, agent: FakeAgent): void {
      live.set(id, agent)
    },
    get(id: string): Agent | undefined {
      return live.get(id) as unknown as Agent | undefined
    },
    list(): Agent[] {
      return [...live.values()] as unknown as Agent[]
    },
  }
  return seam
}

/** A real Context with this row's injected services; `extra` adds or replaces. */
export function makeRoot(extra: Record<string, unknown> = {}): Context {
  const root = new Context()
  // Merged before the first `provide`, not after: cordis refuses to provide a
  // name twice in one scope, so an `extra` seam must win the merge rather than
  // overwrite a default that is already registered.
  const seams: Record<string, unknown> = { agents: fakeAgents(), ...extra }
  for (const [name, value] of Object.entries(seams)) root.provide(name, value as never)
  return root
}
