import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Same ceiling as tools-schema.test.ts: the real @deepseek-ai/dsh-tools pulls a
// host-provided peer that is not installed here, so defineTool passes through.
vi.mock('@deepseek-ai/dsh-tools', () => ({
  defineTool: (options: unknown) => options,
}))

// Ask-mode wiring: capture what ask_session hands to the cross-session layer,
// and give the tool a fake session controller instead of a live host.
const captured = vi.hoisted(() => ({ asks: [] as Array<Record<string, unknown>> }))

vi.mock('../src/cross-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/cross-session')>()
  return {
    ...actual,
    getSessionController: () => ({
      list: async () => ({
        items: [
          {
            sessionId: 'self',
            updatedAt: Date.now(),
            running: false,
            projections: { values: { title: '本会话' } },
          },
          {
            sessionId: 'peer',
            updatedAt: Date.now(),
            running: false,
            projections: { values: { title: '对端会话' } },
          },
        ],
      }),
    }),
    askSession: async (_ctx: unknown, _signal: unknown, input: Record<string, unknown>) => {
      captured.asks.push(input)
      return {
        ok: true,
        target: { sessionId: 'peer', name: '对端会话' },
        delivered: 'native',
        askId: 'ask-test',
        interval: { from: new Date(0).toISOString(), to: null, endedBecause: 'detached' },
        answer: '',
        note: '已投递（异步）',
      }
    },
  }
})

import { Config, unwrapVolatileConfig, type Config as ConfigShape } from '../src/config'
import { registerAdvisorTools, resolveAskDefaults, visibleRosterSessions } from '../src/tools'
import { askStoreDir, writeAskRecord, type AskRecord } from '../src/ask-store'
import { askStoreRoot } from '../src/cross-session'
import type { AdvisorGroupService } from '../src/service'

/** Minimal tool surface the tests call: the mocked defineTool returns the options. */
interface ToolLike {
  name: string
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>
}

/** A config with every other block present and the swarm block under test. */
function swarmConfig(swarm: Partial<ConfigShape['swarm']> = {}): ConfigShape {
  return {
    enabled: true,
    discussion: {
      maxRounds: 2,
      maxAdvisorsPerCall: 3,
      parallel: true,
      autoDeepen: true,
      stopOnConsensus: false,
    },
    trigger: { requireClassifier: true, allowWebFallback: true, confidenceThreshold: 0.6 },
    ui: { theme: 'retro-green', showTimestamps: true, autoExpand: true },
    quota: { enabled: true, maxPerDay: 50 },
    swarm: {
      enabled: true,
      defaultMode: 'wait',
      defaultWaitMs: 180000,
      resultTtlHours: 24,
      rosterIncludeSubagents: false,
      ...swarm,
    },
    advisors: [],
  }
}

function toolset(config: ConfigShape): Map<string, ToolLike> {
  const service = { getConfig: () => config } as unknown as AdvisorGroupService
  const tools = registerAdvisorTools(service) as unknown as ToolLike[]
  return new Map(tools.map((tool) => [tool.name, tool]))
}

async function run(
  config: ConfigShape,
  name: string,
  args: Record<string, unknown> = {},
  exec: unknown = {},
): Promise<Record<string, unknown>> {
  const tool = toolset(config).get(name)
  if (tool === undefined) throw new Error(`missing tool ${name}`)
  return await tool.execute(args, exec)
}

/** The current-session facts ask_session reads from the execution context. */
function selfExec(): unknown {
  return { agent: { session: { id: 'self', snapshotEvents: () => [] } } }
}

/** Old stored configs predate the swarm block entirely. */
describe('swarm config defaults', () => {
  const legacy = {
    enabled: true,
    discussion: { maxRounds: 2, maxAdvisorsPerCall: 3, parallel: true, autoDeepen: true, stopOnConsensus: false },
    trigger: { requireClassifier: true, allowWebFallback: true, confidenceThreshold: 0.6 },
    ui: { theme: 'retro-green', showTimestamps: true, autoExpand: true },
    quota: { enabled: true, maxPerDay: 50 },
    advisors: [],
  }

  it('fills the whole block for a config without a swarm key', () => {
    const resolved = unwrapVolatileConfig(Config(legacy as never)) as ConfigShape
    expect(resolved.swarm).toEqual({
      enabled: true,
      defaultMode: 'wait',
      defaultWaitMs: 180000,
      resultTtlHours: 24,
      rosterIncludeSubagents: false,
      routingEnabled: true,
      routingTopN: 3,
      // The routing engine defaults to the local keyword scorer.
      routingEngine: 'local',
    })
  })

  it('keeps explicitly saved swarm values', () => {
    const resolved = unwrapVolatileConfig(
      Config({
        ...legacy,
        swarm: {
          enabled: false,
          defaultMode: 'detach',
          defaultWaitMs: 60000,
          resultTtlHours: 6,
          rosterIncludeSubagents: true,
          routingEnabled: false,
          routingTopN: 5,
          routingEngine: 'jev',
        },
      } as never),
    ) as ConfigShape
    expect(resolved.swarm).toEqual({
      enabled: false,
      defaultMode: 'detach',
      defaultWaitMs: 60000,
      resultTtlHours: 6,
      rosterIncludeSubagents: true,
      routingEnabled: false,
      routingTopN: 5,
      routingEngine: 'jev',
    })
  })
})

describe('swarm.enabled = false', () => {
  const disabled = swarmConfig({ enabled: false })

  it('refuses ask_session with swarm-disabled', async () => {
    const value = await run(disabled, 'ask_session', { target: 'peer', question: '在吗？' })
    expect(value).toMatchObject({
      ok: false,
      error: 'swarm-disabled',
      message: '蜂群模式已在设置里关闭（设置 → 插件 → 顾问群 → 全局蜂群）。',
      answer: '',
      note: '',
    })
    expect(value.interval).toMatchObject({ endedBecause: 'error' })
  })

  it('refuses list_sessions with swarm-disabled', async () => {
    const value = await run(disabled, 'list_sessions')
    expect(value).toMatchObject({
      ok: false,
      error: 'swarm-disabled',
      count: 0,
      sessions: [],
    })
  })

  it('refuses ask_result with swarm-disabled', async () => {
    const value = await run(disabled, 'ask_result')
    expect(value).toMatchObject({
      ok: false,
      error: 'swarm-disabled',
      count: 0,
      results: [],
    })
  })
})

describe('resolveAskDefaults', () => {
  it('uses the configured mode and wait when the call omits both', () => {
    expect(resolveAskDefaults({}, { defaultMode: 'detach', defaultWaitMs: 60000 })).toEqual({
      waitMs: 60000,
      detach: true,
    })
    expect(resolveAskDefaults({}, { defaultMode: 'wait', defaultWaitMs: 180000 })).toEqual({
      waitMs: 180000,
      detach: false,
    })
  })

  it('lets an explicit argument win over the configured default', () => {
    expect(
      resolveAskDefaults(
        { waitMs: 5000, detach: false },
        { defaultMode: 'detach', defaultWaitMs: 60000 },
      ),
    ).toEqual({ waitMs: 5000, detach: false })
  })

  it('fills only the omitted half of the pair', () => {
    expect(resolveAskDefaults({ detach: false }, { defaultMode: 'detach', defaultWaitMs: 60000 })).toEqual({
      waitMs: 60000,
      detach: false,
    })
    expect(resolveAskDefaults({ waitMs: 9000 }, { defaultMode: 'detach', defaultWaitMs: 60000 })).toEqual({
      waitMs: 9000,
      detach: true,
    })
  })
})

describe('ask_session ask-mode defaults (wiring)', () => {
  beforeEach(() => {
    captured.asks.length = 0
  })

  it('honours defaultMode/defaultWaitMs when the call omits both', async () => {
    await run(
      swarmConfig({ defaultMode: 'detach', defaultWaitMs: 60000 }),
      'ask_session',
      { target: 'peer', question: '在吗？' },
      selfExec(),
    )
    expect(captured.asks).toHaveLength(1)
    expect(captured.asks[0]).toMatchObject({ waitMs: 60000, detach: true })
  })

  it('overrides them when the call passes explicit arguments', async () => {
    await run(
      swarmConfig({ defaultMode: 'detach', defaultWaitMs: 60000 }),
      'ask_session',
      { target: 'peer', question: '在吗？', waitMs: 5000, detach: false },
      selfExec(),
    )
    expect(captured.asks[0]).toMatchObject({ waitMs: 5000, detach: false })
  })
})

describe('visibleRosterSessions', () => {  const sessions = [
    { sessionId: 'main', updatedAt: 1, running: false },
    { sessionId: 'sub', updatedAt: 2, running: false, origin: 'subagent' as const },
  ]

  it('hides subagent sessions by default', () => {
    expect(visibleRosterSessions(sessions, false).map((row) => row.sessionId)).toEqual(['main'])
  })

  it('lists them when the setting is enabled', () => {
    expect(visibleRosterSessions(sessions, true).map((row) => row.sessionId)).toEqual(['main', 'sub'])
  })
})

describe('ask_result prunes expired detached results', () => {
  const HOUR = 3_600_000
  let home: string
  let savedHome: string | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'advisor-group-swarm-'))
    savedHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
  })

  afterEach(() => {
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    rmSync(home, { recursive: true, force: true })
  })

  function record(askId: string, createdAt: number): AskRecord {
    return {
      askId,
      sessionId: 'session-a',
      targetSessionId: 'session-b',
      targetName: '构建会话',
      question: '这个方案可行吗？',
      state: 'waiting',
      createdAt,
      from: new Date(createdAt).toISOString(),
    }
  }

  async function listedIds(ttlHours: number): Promise<string[]> {
    const value = await run(swarmConfig({ resultTtlHours: ttlHours }), 'ask_result')
    expect(value.ok).toBe(true)
    const results = value.results as Array<{ askId: string }>
    return results.map((row) => row.askId)
  }

  it('removes records older than the configured TTL before listing', async () => {
    const dir = askStoreDir(join(home, 'storages', 'advisor-group'))
    expect(dir).toBe(askStoreRoot())
    writeAskRecord(dir, record('old', Date.now() - 2 * HOUR))
    writeAskRecord(dir, record('fresh', Date.now()))

    await expect(listedIds(1)).resolves.toEqual(['fresh'])
  })

  it('clamps absurd TTL hours into 1..720', async () => {
    const dir = askStoreDir(join(home, 'storages', 'advisor-group'))
    writeAskRecord(dir, record('two-hours-old', Date.now() - 2 * HOUR))

    // 0 → clamped to 1 hour: a two-hour-old record goes.
    await expect(listedIds(0)).resolves.toEqual([])

    writeAskRecord(dir, record('two-hours-old', Date.now() - 2 * HOUR))
    // 100000 → clamped to 720 hours: the same record survives.
    await expect(listedIds(100000)).resolves.toEqual(['two-hours-old'])
  })
})
