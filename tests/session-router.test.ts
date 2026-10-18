import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Tool-level cases: the real @deepseek-ai/dsh-tools pulls a host-provided peer
// that is not installed here, so defineTool passes the options through.
vi.mock('@deepseek-ai/dsh-tools', () => ({
  defineTool: (options: unknown) => options,
}))

// Tool-level cases drive ask_session against a fixed roster and record whether
// the cross-session layer was ever asked to deliver. Hoisted because the mock
// factory runs before the module body.
const world = vi.hoisted(() => ({
  roster: [
    {
      sessionId: 'remote-1',
      updatedAt: 1_700_000_000_000,
      running: false,
      cwd: 'I:\\极简遥控器\\src',
      projections: { values: { title: '极简遥控器改造' } },
    },
    {
      sessionId: 'remote-2',
      updatedAt: 1_700_000_100_000,
      running: false,
      cwd: 'I:\\DSH\\dsh-advisor-group',
      projections: { values: { title: '顾问群插件' } },
    },
  ] as Array<Record<string, unknown>>,
  asks: [] as Array<Record<string, unknown>>,
}))

vi.mock('../src/cross-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/cross-session')>()
  return {
    ...actual,
    getSessionController: () => ({
      list: async () => ({ items: world.roster }),
      resolveAgent: async () => ({}),
      prompt: async () => ({}),
    }),
    askSession: async (_ctx: unknown, _signal: unknown, input: Record<string, unknown>) => {
      world.asks.push(input)
      return { ok: false, error: 'target-not-found', message: '没有找到匹配的会话。' }
    },
  }
})

import {
  loadAliases,
  normalizeAliasKey,
  routeSessions,
  saveAlias,
  type RouteCandidate,
} from '../src/session-router'
import type { RosterSource } from '../src/session-roster'
import type { Config as ConfigShape } from '../src/config'
import { registerAdvisorTools } from '../src/tools'
import type { AdvisorGroupService } from '../src/service'

/** Fixed roster clock: time is an input of the router, never read from the wall clock. */
const BASE = 1_700_000_000_000

function row(id: string, title: string, extra: Partial<RosterSource> = {}): RosterSource {
  return {
    sessionId: id,
    updatedAt: BASE,
    running: false,
    projections: { values: { title } },
    ...extra,
  }
}

function ids(candidates: readonly RouteCandidate[]): string[] {
  return candidates.map((candidate) => candidate.sessionId)
}

describe('routeSessions — matches', () => {
  it('finds a title hit and names the keyword that hit', () => {
    const candidates = routeSessions(
      [row('a', '极简遥控器改造'), row('b', '顾问群插件')],
      '遥控器 怎么改',
    )
    expect(candidates[0]).toMatchObject({
      sessionId: 'a',
      name: '极简遥控器改造',
      reason: '标题命中「遥控器」',
    })
    expect(candidates[0].score).toBeGreaterThan(0)
    expect(candidates[0].score).toBeLessThanOrEqual(100)
    expect(ids(candidates)).not.toContain('b')
  })

  it('matches a Chinese project name inside the cwd path segments', () => {
    const candidates = routeSessions(
      [
        row('path', '未命名工程', { cwd: 'I:\\极简遥控器\\src' }),
        row('other', '别的会话', { cwd: 'I:\\DSH\\docs' }),
      ],
      '极简遥控器 的构建脚本',
    )
    expect(candidates[0]).toMatchObject({ sessionId: 'path', reason: '目录命中' })
    expect(ids(candidates)).toEqual(['path'])
  })

  it('matches a pure-ASCII question word for word', () => {
    const candidates = routeSessions([row('en', 'Advisor Group plugin')], 'advisor group')
    expect(candidates[0]).toMatchObject({ sessionId: 'en', score: 100 })
    expect(candidates[0].reason).toContain('标题命中')
  })

  it('matches a mixed CJK/ASCII question', () => {
    const candidates = routeSessions([row('mix', 'DSH 插件配置说明')], 'dsh 插件怎么配')
    expect(candidates[0]).toMatchObject({ sessionId: 'mix', reason: '标题命中「dsh」' })
    expect(candidates[0].score).toBe(66)
  })

  it('ignores a 2-character title that shares only one bigram', () => {
    const candidates = routeSessions(
      [row('weak', '遥控'), row('strong', '遥控器维护手册')],
      '遥控器怎么改',
      { topN: 8 },
    )
    expect(ids(candidates)).toEqual(['strong'])
  })
})

describe('routeSessions — hard channels and order', () => {
  it('always includes a running session, even with no textual overlap', () => {
    const candidates = routeSessions(
      [row('idle', '完全无关的标题'), row('busy', '另一个无关标题', { running: true })],
      '遥控器怎么改',
    )
    expect(candidates).toEqual([
      expect.objectContaining({ sessionId: 'busy', score: 0, reason: '运行中' }),
    ])
  })

  it('breaks ties by running, then recency, then shorter title', () => {
    const candidates = routeSessions(
      [
        row('idle-old', 'alpha beta', { updatedAt: BASE }),
        row('idle-new-long', 'alpha beta alpha', { updatedAt: BASE + 10_000 }),
        row('running-old', 'alpha beta', { running: true, updatedAt: BASE }),
        row('idle-new', 'alpha beta', { updatedAt: BASE + 10_000 }),
      ],
      'alpha beta',
      { topN: 8 },
    )
    expect(ids(candidates)).toEqual(['running-old', 'idle-new', 'idle-new-long', 'idle-old'])
  })
})

describe('routeSessions — zero-hit fallback and caps', () => {
  it('falls back to the wide pool (recent first) when nothing matches', () => {
    const sessions = [
      row('old', 'alpine deploy notes', { updatedAt: BASE - 86_400_000 }),
      row('new', 'burdock pipeline', { updatedAt: BASE }),
      row('mid', 'cedar release', { updatedAt: BASE - 3_600_000 }),
    ]
    const candidates = routeSessions(sessions, '遥控器怎么改', { topN: 2 })
    expect(ids(candidates)).toEqual(['new', 'mid'])
    expect(candidates.every((candidate) => candidate.reason === '最近活跃')).toBe(true)
    // Fewer pool members than topN: return what exists instead of padding.
    expect(routeSessions(sessions, '遥控器怎么改', { topN: 5 })).toHaveLength(3)
  })

  it('clamps topN to 1..8 with a default of 3', () => {
    const sessions = Array.from({ length: 5 }, (_, index) => row(`s${index}`, `alpha ${index}`))
    expect(routeSessions(sessions, 'alpha', { topN: 2 })).toHaveLength(2)
    expect(routeSessions(sessions, 'alpha', { topN: 0 })).toHaveLength(1)
    expect(routeSessions(sessions, 'alpha', { topN: 100 })).toHaveLength(5)
    expect(routeSessions(sessions, 'alpha')).toHaveLength(3)
  })
})

describe('routeSessions — aliases and malformed input', () => {
  it('adds a big bonus when the question contains a remembered phrasing', () => {
    const candidates = routeSessions(
      [row('x', 'alpine deploy'), row('y', 'burdock pipeline')],
      '帮我看看那个极简 遥控器 的事',
      { aliases: { '极简遥控器': 'y' } },
    )
    expect(candidates).toEqual([
      expect.objectContaining({ sessionId: 'y', score: 60, reason: '别名命中' }),
    ])
  })

  it('ignores an alias whose session is no longer in the roster', () => {
    const candidates = routeSessions([row('x', 'alpine deploy')], '看看 极简遥控器', {
      aliases: { '极简遥控器': 'gone' },
    })
    // Nothing matched by text, so the wide pool answers instead of the ghost id.
    expect(ids(candidates)).toEqual(['x'])
    expect(candidates[0].reason).not.toBe('别名命中')
  })

  it('never throws on odd input', () => {
    expect(routeSessions(null as unknown as readonly RosterSource[], 'q')).toEqual([])
    expect(routeSessions(undefined as unknown as readonly RosterSource[], undefined as never)).toEqual([])
    const junk = [null, 42, {}, { sessionId: '' }] as unknown as readonly RosterSource[]
    expect(routeSessions(junk, '遥控器')).toEqual([])
    const odd: RosterSource = {
      sessionId: 'odd',
      updatedAt: Number.NaN,
      running: false,
      cwd: 42 as never,
      projections: { values: { title: 7 } },
    }
    expect(() => routeSessions([odd], 'odd')).not.toThrow()
    expect(routeSessions([row('a', 'alpha')], 'alpha', { topN: Number.NaN })).toHaveLength(1)
    expect(normalizeAliasKey(undefined as never)).toBe('')
    expect(normalizeAliasKey('  极简 · 遥控器！ ')).toBe('极简遥控器')
  })
})

describe('alias file', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'advisor-group-router-alias-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips phrasing → sessionId through saveAlias/loadAliases', () => {
    const file = join(dir, 'nested', 'aliases.json')
    saveAlias(file, '极简 遥控器', 'session-1')
    saveAlias(file, '顾问群', 'session-2')
    expect(loadAliases(file)).toEqual({
      极简遥控器: 'session-1',
      顾问群: 'session-2',
    })
    // Re-saving the same phrasing replaces the target.
    saveAlias(file, '极简 遥控器', 'session-3')
    expect(loadAliases(file)['极简遥控器']).toBe('session-3')
  })

  it('ignores empty phrasing and empty sessionId', () => {
    const file = join(dir, 'aliases.json')
    saveAlias(file, '  ·  ', 'session-1')
    saveAlias(file, '遥控器', '')
    expect(loadAliases(file)).toEqual({})
  })

  it('reads a missing, corrupt or non-object file as {}', () => {
    const file = join(dir, 'aliases.json')
    expect(loadAliases(file)).toEqual({})
    expect(loadAliases(join(dir, 'no-such-dir', 'aliases.json'))).toEqual({})
    writeFileSync(file, '{ not json', 'utf8')
    expect(loadAliases(file)).toEqual({})
    writeFileSync(file, '[]', 'utf8')
    expect(loadAliases(file)).toEqual({})
    writeFileSync(file, JSON.stringify({ 遥控器: 'session-1', 坏条目: 42 }), 'utf8')
    expect(loadAliases(file)).toEqual({ 遥控器: 'session-1' })
  })
})

// ---------------------------------------------------------------------------
// Tool level: ask_session with no named target
// ---------------------------------------------------------------------------

interface ToolLike {
  name: string
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>
}

function toolConfig(routing: { enabled?: boolean; topN?: number } = {}): ConfigShape {
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
      routingEnabled: routing.enabled ?? true,
      routingTopN: routing.topN ?? 3,
    },
    advisors: [],
  }
}

async function runTool(
  config: ConfigShape,
  name: string,
  args: Record<string, unknown>,
  exec: unknown,
): Promise<Record<string, unknown>> {
  const service = { getConfig: () => config } as unknown as AdvisorGroupService
  const tools = registerAdvisorTools(service) as unknown as ToolLike[]
  const tool = tools.find((candidate) => candidate.name === name)
  if (tool === undefined) throw new Error(`missing tool ${name}`)
  return await tool.execute(args, exec)
}

/** The current-session facts ask_session reads from the execution context. */
function selfExec(): unknown {
  return { signal: new AbortController().signal, agent: { session: { id: 'self', snapshotEvents: () => [] } } }
}

describe('ask_session without a target', () => {
  let home: string
  let savedHome: string | undefined

  beforeEach(() => {
    world.asks.length = 0
    home = mkdtempSync(join(tmpdir(), 'advisor-group-router-home-'))
    savedHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
  })

  afterEach(() => {
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    rmSync(home, { recursive: true, force: true })
  })

  it('returns target-unspecified with candidates and never delivers', async () => {
    const value = await runTool(
      toolConfig({ topN: 3 }),
      'ask_session',
      { question: '遥控器界面怎么改' },
      selfExec(),
    )
    expect(value).toMatchObject({
      ok: false,
      error: 'target-unspecified',
      message: '没有指定会话。下面按问题匹配出的候选，请让用户挑一个（或直接点名会话）再投递。',
      answer: '',
      note: '',
    })
    expect((value.interval as { endedBecause: string }).endedBecause).toBe('error')
    const routeCandidates = value.routeCandidates as RouteCandidate[]
    expect(routeCandidates.length).toBeGreaterThan(0)
    expect(routeCandidates[0]).toMatchObject({ sessionId: 'remote-1' })
    expect(typeof routeCandidates[0].score).toBe('number')
    expect(typeof routeCandidates[0].reason).toBe('string')
    // Routing is a proposal only: nothing reached the delivery layer.
    expect(world.asks).toHaveLength(0)
  })

  it('keeps the old missing-target behaviour when routing is off', async () => {
    const value = await runTool(
      toolConfig({ enabled: false }),
      'ask_session',
      { question: '遥控器界面怎么改' },
      selfExec(),
    )
    expect(value).toMatchObject({ ok: false, error: 'target-not-found' })
    expect(value.routeCandidates).toBeUndefined()
    expect(world.asks).toHaveLength(1)
  })

  it('keeps the old behaviour when the roster yields no candidates', async () => {
    const savedRoster = world.roster
    world.roster = []
    try {
      const value = await runTool(toolConfig(), 'ask_session', { question: '遥控器界面怎么改' }, selfExec())
      expect(value).toMatchObject({ ok: false, error: 'target-not-found' })
      expect(value.routeCandidates).toBeUndefined()
      expect(world.asks).toHaveLength(1)
    } finally {
      world.roster = savedRoster
    }
  })
})
