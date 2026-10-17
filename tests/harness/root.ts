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
import type { UserMessage } from '@deepseek-ai/dsh-llm'
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
  readonly message: UserMessage
}

export interface AgentsSeam {
  /** Every `followup` the row made, in order, across every session. */
  readonly delivered: readonly Delivery[]
  /** Register an agent the registry can resolve. */
  add(agent: FakeAgent): FakeAgent
}

export interface FakeAgent {
  readonly id: string
  readonly options: { provider?: string; model?: string }
  readonly status: 'idle' | 'running'
  /** Queue a message, as the real agent does. The seam records every call. */
  followup(message: UserMessage): void
  /** Make `agents.get` stop resolving this id. */
  kill(): void
}

/**
 * A recording `agents` seam.
 *
 * `delivered` is the *live* set: an agent removed by `kill()` stops receiving
 * wakeups, so a case can prove the row handles a session that went away rather
 * than only the happy path.
 *
 * The recording lives on the wrapper the registry hands the row, not on the
 * agent, so there is exactly one place a delivery is observable from. The
 * wrapper reads through to the agent for everything else, which is what keeps
 * a case's own view of its session and the row's the same session.
 */
export function fakeAgents(): AgentsSeam {
  const delivered: Delivery[] = []
  const live = new Map<string, Agent>()

  const seam = {
    delivered,
    add(agent: FakeAgent): FakeAgent {
      // `kill` is how a case says "the registry must stop resolving this id",
      // so the seam rebinds it at registration rather than leaving the case to
      // unregister by hand and hope the two agree. The agent's own `kill` runs
      // first, so the agent's state cannot outlive its registration.
      const agentKill = agent.kill.bind(agent)
      agent.kill = () => {
        agentKill()
        live.delete(agent.id)
      }
      live.set(agent.id, observed(agent, delivered))
      return agent
    },
    get(id: string): Agent | undefined {
      return live.get(id)
    },
  }
  return seam
}

/**
 * One session as the row sees it: the same session, with `followup` observed.
 *
 * `followup` records and then calls through, so a fake that wants a delivery
 * to fail can still fail it. Every other member reads through to the agent,
 * which is what keeps a case's own view of its session and the row's the same
 * session — the row resolves the session itself and compares nothing, but a
 * wrapper that snapshotted `options` would quietly go stale against a case
 * that reroutes its session.
 */
function observed(agent: FakeAgent, delivered: Delivery[]): Agent {
  return {
    get id(): string {
      return agent.id
    },
    get options(): { provider?: string; model?: string } {
      return agent.options
    },
    get status(): 'idle' | 'running' {
      return agent.status
    },
    followup(message: UserMessage): void {
      delivered.push({ sessionId: agent.id, message })
      agent.followup(message)
    },
  } as unknown as Agent
}

/**
 * The `systemPrompt` seam, reduced to the one call this row makes.
 *
 * `contexts` is the LIVE set: the disposer `context()` returns removes its own
 * entry, so a case can prove a detached subscription unwound.
 */
export interface SystemPromptSeam {
  readonly contexts: readonly { readonly name: string }[]
  context(definition: { readonly name: string; readonly order?: number }): () => void
}

export function fakeSystemPrompt(): SystemPromptSeam {
  const contexts: { name: string }[] = []
  return {
    contexts,
    context(definition): () => void {
      contexts.push({ name: definition.name })
      return () => {
        const index = contexts.findIndex(entry => entry.name === definition.name)
        if (index !== -1) contexts.splice(index, 1)
      }
    },
  }
}

/** The `tools` seam, reduced to `register` and its live set. */
export interface ToolsSeam {
  readonly registered: readonly { readonly name: string }[]
  register(definition: { readonly name: string }): () => void
}

export function fakeTools(): ToolsSeam {
  const registered: { name: string }[] = []
  return {
    registered,
    register(definition): () => void {
      registered.push({ name: definition.name })
      return () => {
        const index = registered.findIndex(entry => entry.name === definition.name)
        if (index !== -1) registered.splice(index, 1)
      }
    },
  }
}

/** A real Context with this row's injected services; `extra` adds or replaces. */
export function makeRoot(extra: Record<string, unknown> = {}): Context {
  const root = new Context()
  // Merged before the first `provide`, not after: cordis refuses to provide a
  // name twice in one scope, so an `extra` seam must win the merge rather than
  // overwrite a default that is already registered.
  const seams: Record<string, unknown> = {
    agents: fakeAgents(),
    systemPrompt: fakeSystemPrompt(),
    tools: fakeTools(),
    ...extra,
  }
  for (const [name, value] of Object.entries(seams)) root.provide(name, value as never)
  return root
}
