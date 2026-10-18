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
  activityLabel,
  clearRouteCache,
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
import { writeAskRecord } from '../src/ask-store'
import { askStoreRoot } from '../src/cross-session'

/** Fixed roster clock: time is an input of the router, never read from the wall clock. */
const BASE = 1_700_000_000_000

// The route cache is module state: every case starts from an empty one.
beforeEach(() => {
  clearRouteCache()
})

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
      reason: '标题命中「遥控器」 · 冷',
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
    expect(candidates[0]).toMatchObject({ sessionId: 'path', reason: '目录命中 · 冷' })
    expect(ids(candidates)).toEqual(['path'])
  })

  it('shortens a title-less candidate to the last path segment', () => {
    const candidates = routeSessions(
      [{ sessionId: 'p', updatedAt: BASE, running: false, cwd: 'I:\\极简遥控器\\极简遥控器' }],
      '极简遥控器 怎么改',
    )
    expect(candidates[0]).toMatchObject({ sessionId: 'p', name: '极简遥控器' })
  })

  it('matches a pure-ASCII question word for word', () => {
    const candidates = routeSessions([row('en', 'Advisor Group plugin')], 'advisor group')
    expect(candidates[0]).toMatchObject({ sessionId: 'en', score: 100 })
    expect(candidates[0].reason).toContain('标题命中')
  })

  it('matches a mixed CJK/ASCII question', () => {
    const candidates = routeSessions([row('mix', 'DSH 插件配置说明')], 'dsh 插件怎么配')
    expect(candidates[0]).toMatchObject({ sessionId: 'mix', reason: '标题命中「dsh」 · 冷' })
    // Dice (36, capped by 40) + title keyword 40.
    expect(candidates[0].score).toBe(76)
  })

  it('caps the pure-fuzzy score and keeps real hits decisive', () => {
    const candidates = routeSessions(
      [
        // Shares only the 简遥/遥控 bigrams: a fuzzy match, no keyword inside.
        row('fuzzy', '简遥控'),
        // A real title keyword hit.
        row('titled', '极简遥控器改造'),
        // A real cwd-segment hit.
        row('cwd', '别的会话', { cwd: 'I:\\极简遥控器\\src' }),
      ],
      '极简遥控器 的构建脚本',
      { topN: 8 },
    )
    expect(ids(candidates)).toEqual(['titled', 'cwd', 'fuzzy'])
    const fuzzy = candidates.find((candidate) => candidate.sessionId === 'fuzzy')
    expect(fuzzy?.score).toBeLessThanOrEqual(40)
    expect(candidates[0].score).toBeGreaterThan(fuzzy?.score ?? 0)
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

// ---------------------------------------------------------------------------
// Live regression (2026-10-18): the real roster held titled 极简遥控器新 rows
// plus title-less rows under I:\极简遥控器, all sharing the fallback name
// 极简遥控器. A natural Chinese question named the project without spaces, and
// the titled row fell out of the top three behind rows that only matched
// through their working directory. Eleven rows, as on the live host.
// ---------------------------------------------------------------------------
const LIVE_QUESTION = '那个做极简遥控器的会话，当前的开发进度和最新版本号是多少？'
const ONE_HOUR = 3_600_000
const ONE_DAY = 86_400_000

function liveRoster(): RosterSource[] {
  const hoursAgo = (hours: number): number => BASE - hours * ONE_HOUR
  const daysAgo = (days: number): number => BASE - days * ONE_DAY
  return [
    {
      sessionId: 'titled-main',
      updatedAt: hoursAgo(2),
      running: false,
      cwd: 'I:\\极简遥控器\\极简遥控器',
      projections: { values: { title: '极简遥控器新' } },
    },
    {
      sessionId: 'titled-dup-8d',
      updatedAt: daysAgo(8),
      running: false,
      cwd: 'I:\\极简遥控器\\极简遥控器',
      projections: { values: { title: '极简遥控器新 (1)' } },
    },
    {
      sessionId: 'titled-dup-9d',
      updatedAt: daysAgo(9),
      running: false,
      cwd: 'I:\\极简遥控器',
      projections: { values: { title: '极简遥控器新 (1)' } },
    },
    { sessionId: 'untitled-14d', updatedAt: daysAgo(14), running: false, cwd: 'I:\\极简遥控器' },
    { sessionId: 'untitled-23d-a', updatedAt: daysAgo(23), running: false, cwd: 'I:\\极简遥控器' },
    {
      sessionId: 'untitled-23d-b',
      updatedAt: daysAgo(23),
      running: false,
      cwd: 'I:\\极简遥控器\\极简遥控器',
    },
    {
      sessionId: 'plugin',
      updatedAt: hoursAgo(30),
      running: false,
      cwd: 'I:\\DSH\\dsh-advisor-group',
      projections: { values: { title: '顾问群插件' } },
    },
    {
      sessionId: 'kb',
      updatedAt: daysAgo(2),
      running: false,
      cwd: 'D:\\X\\X',
      projections: { values: { title: '知识库整理' } },
    },
    {
      sessionId: 'site',
      updatedAt: daysAgo(3),
      running: false,
      cwd: 'I:\\site',
      projections: { values: { title: '网站改版' } },
    },
    {
      sessionId: 'notes',
      updatedAt: daysAgo(5),
      running: false,
      cwd: 'D:\\notes',
      projections: { values: { title: '笔记' } },
    },
    { sessionId: 'dsh', updatedAt: daysAgo(6), running: false, cwd: 'I:\\DSH' },
  ]
}

describe('routeSessions — title named inside the question (live regression)', () => {
  it('ranks the titled session above cwd-only rows and inside the top three', () => {
    const all = routeSessions(liveRoster(), LIVE_QUESTION, { topN: 8 })
    const firstCwdOnly = all.findIndex((candidate) => candidate.reason.startsWith('目录命中'))
    expect(firstCwdOnly).toBeGreaterThan(-1)
    // The row the user meant, matched through its title even though the
    // question writes 极简遥控器 without a space and the title adds 新.
    expect(all[0]).toMatchObject({
      sessionId: 'titled-main',
      name: '极简遥控器新',
      reason: '标题命中「极简遥控器」 · 冷',
    })
    expect(all.findIndex((candidate) => candidate.sessionId === 'titled-main')).toBeLessThan(firstCwdOnly)
    // Default topN: the titled row is one of the three offered choices.
    expect(ids(routeSessions(liveRoster(), LIVE_QUESTION))).toContain('titled-main')
  })

  it('scores every title hit strictly above every cwd-only hit', () => {
    const all = routeSessions(liveRoster(), LIVE_QUESTION, { topN: 8 })
    const titleScores = all.filter((candidate) => candidate.reason.startsWith('标题命中')).map((c) => c.score)
    const cwdScores = all.filter((candidate) => candidate.reason.startsWith('目录命中')).map((c) => c.score)
    expect(titleScores.length).toBeGreaterThan(0)
    expect(cwdScores.length).toBeGreaterThan(0)
    for (const title of titleScores) {
      for (const cwd of cwdScores) expect(title).toBeGreaterThan(cwd)
    }
  })

  it('never drops a titled row in favour of a fallback-named row when labels collide', () => {
    const sessions: RosterSource[] = [
      // Same display name as the title-less rows, but a real title.
      { ...row('titled', '极简遥控器'), cwd: 'I:\\极简遥控器' },
      { sessionId: 'fallback-a', updatedAt: BASE - 14 * ONE_DAY, running: false, cwd: 'I:\\极简遥控器' },
      { sessionId: 'fallback-b', updatedAt: BASE - 23 * ONE_DAY, running: false, cwd: 'I:\\极简遥控器' },
      {
        sessionId: 'fallback-c',
        updatedAt: BASE - 23 * ONE_DAY,
        running: false,
        cwd: 'I:\\极简遥控器\\极简遥控器',
      },
    ]
    // Two slots: the titled row takes one, the repeated fallback label takes one.
    const candidates = routeSessions(sessions, LIVE_QUESTION, { topN: 2 })
    expect(ids(candidates)).toContain('titled')
    expect(ids(candidates)[0]).toBe('titled')
    expect(candidates.filter((candidate) => candidate.sessionId.startsWith('fallback'))).toHaveLength(1)
  })

  it('keeps two equal titles as two candidates (dedup covers fallback labels only)', () => {
    const candidates = routeSessions(
      [
        { ...row('twin-a', '极简遥控器新'), cwd: 'I:\\极简遥控器\\极简遥控器' },
        { ...row('twin-b', '极简遥控器新'), cwd: 'I:\\极简遥控器\\极简遥控器' },
      ],
      LIVE_QUESTION,
      { topN: 3 },
    )
    expect(ids(candidates)).toEqual(['twin-a', 'twin-b'])
  })

  it('matches a project folder spoken inside the question without spaces', () => {
    const candidates = routeSessions(
      [{ sessionId: 'p', updatedAt: BASE, running: false, cwd: 'I:\\极简遥控器' }],
      '那个做极简遥控器的会话现在怎么样了',
    )
    expect(candidates[0]).toMatchObject({ sessionId: 'p', name: '极简遥控器', reason: '目录命中 · 冷' })
  })
})

describe('routeSessions — hard channels and order', () => {
  it('always includes a running session, even with no textual overlap', () => {
    const candidates = routeSessions(
      [row('idle', '完全无关的标题'), row('busy', '另一个无关标题', { running: true })],
      '遥控器怎么改',
    )
    expect(candidates).toEqual([
      expect.objectContaining({ sessionId: 'busy', score: 10, reason: '运行中 · 冷' }),
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

  it('adds the running bonus on top of the match score', () => {
    const candidates = routeSessions([row('busy', '简遥控', { running: true })], '极简遥控器 的构建脚本')
    expect(candidates[0]).toMatchObject({ sessionId: 'busy', score: 50 })
  })
})

describe('routeSessions — accumulated-context tie-break', () => {
  it('prefers the larger known log size among equal scores in the same project', () => {
    const candidates = routeSessions(
      [
        row('small', 'alpha beta', { cwd: 'I:\\proj', updatedAt: BASE + 10_000, sizeBytes: 100 }),
        row('big', 'alpha beta', { cwd: 'I:\\proj', updatedAt: BASE, sizeBytes: 900_000 }),
      ],
      'alpha beta',
      { topN: 8, cache: false },
    )
    expect(ids(candidates)).toEqual(['big', 'small'])
    // The bigger context decided the order here: without it the newer row won.
    expect(candidates[0].reason).toContain('积累多')
    expect(candidates[1].reason).not.toContain('积累多')
  })

  it('never lets a bigger context outrank a higher relevance score', () => {
    const candidates = routeSessions(
      [
        row('relevant', '遥控器改造', { cwd: 'I:\\proj', sizeBytes: 1 }),
        row('huge', '遥控器维护手册', { cwd: 'I:\\proj', sizeBytes: 5_000_000 }),
      ],
      '遥控器改造',
      { topN: 8, cache: false },
    )
    expect(ids(candidates)[0]).toBe('relevant')
    expect(candidates[0].score).toBeGreaterThan(candidates[1].score)
    expect(candidates[0].reason).not.toContain('积累多')
  })

  it('does not use size across different projects', () => {
    const candidates = routeSessions(
      [
        row('huge-other', 'alpha beta', { cwd: 'I:\\other', updatedAt: BASE, sizeBytes: 9_000_000 }),
        row('small-here', 'alpha beta', { cwd: 'I:\\proj', updatedAt: BASE + 10_000, sizeBytes: 1 }),
      ],
      'alpha beta',
      { topN: 8, cache: false },
    )
    expect(ids(candidates)).toEqual(['small-here', 'huge-other'])
    expect(candidates[0].reason).not.toContain('积累多')
  })

  it('does not use size when only one side knows it, or when running already decides', () => {
    const unknown = routeSessions(
      [
        row('known-small', 'alpha beta', { cwd: 'I:\\proj', updatedAt: BASE + 1, sizeBytes: 10 }),
        row('unknown-big', 'alpha beta', { cwd: 'I:\\proj', updatedAt: BASE + 2 }),
      ],
      'alpha beta',
      { topN: 8, cache: false },
    )
    expect(ids(unknown)).toEqual(['unknown-big', 'known-small'])
    expect(unknown[0].reason).not.toContain('积累多')
    const running = routeSessions(
      [
        row('busy', 'alpha beta', { cwd: 'I:\\proj', running: true, updatedAt: BASE, sizeBytes: 1 }),
        row('idle', 'alpha beta', { cwd: 'I:\\proj', updatedAt: BASE + 10_000, sizeBytes: 9_000_000 }),
      ],
      'alpha beta',
      { topN: 8, cache: false },
    )
    expect(ids(running)).toEqual(['busy', 'idle'])
  })

  it('falls back to recency when no size is known at all', () => {
    const candidates = routeSessions(
      [
        row('older', 'alpha beta', { cwd: 'I:\\proj', updatedAt: BASE }),
        row('newer', 'alpha beta', { cwd: 'I:\\proj', updatedAt: BASE + 10_000 }),
      ],
      'alpha beta',
      { topN: 8, cache: false },
    )
    expect(ids(candidates)).toEqual(['newer', 'older'])
    for (const candidate of candidates) expect(candidate.reason).not.toContain('积累多')
  })
})

describe('activityLabel', () => {
  const NOW = 1_700_000_000_000
  const HOUR = 3_600_000
  const DAY = 86_400_000

  it('labels the last hour 热, the last day 温, anything older 冷', () => {
    expect(activityLabel(NOW, NOW)).toBe('热')
    expect(activityLabel(NOW - HOUR, NOW)).toBe('热')
    expect(activityLabel(NOW - HOUR - 1, NOW)).toBe('温')
    expect(activityLabel(NOW - DAY, NOW)).toBe('温')
    expect(activityLabel(NOW - DAY - 1, NOW)).toBe('冷')
    expect(activityLabel(NOW - 7 * DAY, NOW)).toBe('冷')
    expect(activityLabel(NOW - 30 * DAY, NOW)).toBe('冷')
    expect(activityLabel(Number.NaN, NOW)).toBe('冷')
  })

  it('carries the label on every candidate reason', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(NOW)
      const candidates = routeSessions(
        [
          row('hot', 'alpha beta', { cwd: 'I:\\proj', updatedAt: NOW - HOUR }),
          row('warm', 'alpha beta', { cwd: 'I:\\proj2', updatedAt: NOW - DAY }),
          row('cold', 'alpha beta', { cwd: 'I:\\proj3', updatedAt: NOW - 3 * DAY }),
        ],
        'alpha beta',
        { topN: 8, cache: false },
      )
      const reasonOf = (sessionId: string): string =>
        candidates.find((candidate) => candidate.sessionId === sessionId)?.reason ?? ''
      expect(reasonOf('hot')).toContain(' · 热')
      expect(reasonOf('warm')).toContain(' · 温')
      expect(reasonOf('cold')).toContain(' · 冷')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('routeSessions — route cache', () => {
  const QUESTION = 'alpha beta'

  it('answers from the cache within the TTL, and re-routes after clearRouteCache', () => {
    expect(ids(routeSessions([row('a', 'alpha beta')], QUESTION))).toEqual(['a'])
    // A different roster, same question: the cached pass answers.
    expect(ids(routeSessions([row('b', 'alpha beta')], QUESTION))).toEqual(['a'])
    clearRouteCache()
    expect(ids(routeSessions([row('b', 'alpha beta')], QUESTION))).toEqual(['b'])
  })

  it('bypasses the cache with cache:false and never fills it from a bypass', () => {
    expect(ids(routeSessions([row('a', 'alpha beta')], QUESTION, { cache: false }))).toEqual(['a'])
    // Nothing was cached by the bypassing pass, so this one sees the new roster.
    expect(ids(routeSessions([row('b', 'alpha beta')], QUESTION))).toEqual(['b'])
    // A bypassing pass does not overwrite the cached entry either.
    expect(ids(routeSessions([row('c', 'alpha beta')], QUESTION, { cache: false }))).toEqual(['c'])
    expect(ids(routeSessions([row('d', 'alpha beta')], QUESTION))).toEqual(['b'])
  })

  it('re-routes once the 180 s TTL has passed', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(BASE)
      expect(ids(routeSessions([row('a', 'alpha beta')], QUESTION))).toEqual(['a'])
      vi.setSystemTime(BASE + 179_000)
      expect(ids(routeSessions([row('b', 'alpha beta')], QUESTION))).toEqual(['a'])
      vi.setSystemTime(BASE + 181_000)
      expect(ids(routeSessions([row('b', 'alpha beta')], QUESTION))).toEqual(['b'])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('routeSessions — noise rows', () => {
  it('drops blank sessions and title-generation leftovers, keeping real rows', () => {
    const candidates = routeSessions(
      [
        row('blank', '遥控器改造', { blank: true }),
        row('generated', '生成会话标题'),
        row('greeting', '你好，'),
        row('real', '遥控器维护'),
      ],
      '遥控器怎么改',
      { topN: 8 },
    )
    expect(ids(candidates)).toEqual(['real'])
  })

  it('drops the asking session when its id is passed', () => {
    const sessions = [row('self', '遥控器改造'), row('other', '遥控器维护')]
    expect(ids(routeSessions(sessions, '遥控器怎么改', { currentSessionId: 'self', topN: 8 }))).toEqual(['other'])
    // The fallback pool must hide it too.
    const fallback = routeSessions(sessions, 'zzz 无匹配问题', { currentSessionId: 'self', topN: 8 })
    expect(ids(fallback)).toEqual(['other'])
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
    expect(candidates.every((candidate) => candidate.reason.startsWith('最近活跃'))).toBe(true)
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
      expect.objectContaining({ sessionId: 'y', score: 60, reason: '别名命中 · 冷' }),
    ])
  })

  it('ignores an alias whose session is no longer in the roster', () => {
    const candidates = routeSessions([row('x', 'alpine deploy')], '看看 极简遥控器', {
      aliases: { '极简遥控器': 'gone' },
    })
    // Nothing matched by text, so the wide pool answers instead of the ghost id.
    expect(ids(candidates)).toEqual(['x'])
    expect(candidates[0].reason).not.toContain('别名命中')
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

  it('never offers the asking session itself as a candidate', async () => {
    const savedRoster = world.roster
    world.roster = [
      ...savedRoster,
      {
        sessionId: 'self',
        updatedAt: 1_700_000_050_000,
        running: false,
        cwd: 'I:\\极简遥控器',
        projections: { values: { title: '遥控器维护' } },
      },
    ]
    try {
      const value = await runTool(toolConfig(), 'ask_session', { question: '遥控器界面怎么改' }, selfExec())
      const routeCandidates = value.routeCandidates as RouteCandidate[]
      expect(routeCandidates.map((candidate) => candidate.sessionId)).not.toContain('self')
      expect(routeCandidates.length).toBeGreaterThan(0)
    } finally {
      world.roster = savedRoster
    }
  })

  it('marks a candidate this session asked in the last ten minutes', async () => {
    writeAskRecord(askStoreRoot(), {
      askId: 'ask-recent-1',
      sessionId: 'self',
      targetSessionId: 'remote-1',
      targetName: '极简遥控器改造',
      question: '遥控器界面怎么改',
      state: 'done',
      createdAt: Date.now() - 60_000,
      from: new Date().toISOString(),
    })
    const value = await runTool(toolConfig({ topN: 3 }), 'ask_session', { question: '遥控器界面怎么改' }, selfExec())
    const routeCandidates = value.routeCandidates as RouteCandidate[]
    expect(routeCandidates.find((candidate) => candidate.sessionId === 'remote-1')?.reason).toContain('刚问过')
    for (const candidate of routeCandidates.filter((item) => item.sessionId !== 'remote-1')) {
      expect(candidate.reason).not.toContain('刚问过')
    }
  })

  it('leaves the reason alone when the last ask is older than ten minutes', async () => {
    writeAskRecord(askStoreRoot(), {
      askId: 'ask-recent-2',
      sessionId: 'self',
      targetSessionId: 'remote-1',
      targetName: '极简遥控器改造',
      question: '遥控器界面怎么改',
      state: 'done',
      createdAt: Date.now() - 11 * 60_000,
      from: new Date().toISOString(),
    })
    const value = await runTool(toolConfig({ topN: 3 }), 'ask_session', { question: '遥控器界面怎么改' }, selfExec())
    const routeCandidates = value.routeCandidates as RouteCandidate[]
    for (const candidate of routeCandidates) expect(candidate.reason).not.toContain('刚问过')
  })
})

describe('list_sessions row diagnostics', () => {
  it('declares hasTitle as a required row field', () => {
    const tools = registerAdvisorTools({ getConfig: () => toolConfig() } as unknown as AdvisorGroupService)
    const tool = tools.find((candidate) => candidate.name === 'list_sessions') as unknown as {
      output: {
        schema: {
          properties: {
            sessions: { items: { properties: Record<string, { type?: string; required?: boolean }> } }
          }
        }
      }
    }
    expect(tool.output.schema.properties.sessions.items.properties.hasTitle).toEqual({
      type: 'boolean',
      required: true,
    })
  })

  it('reports hasTitle, drops noise rows, and shortens fallback names', async () => {
    const savedRoster = world.roster
    const updatedAt = 1_700_000_000_000
    world.roster = [
      ...savedRoster,
      {
        sessionId: 'blank',
        updatedAt,
        running: false,
        blank: true,
        cwd: 'I:\\blank',
        projections: { values: { title: '看起来正常的标题' } },
      },
      {
        sessionId: 'generated',
        updatedAt,
        running: false,
        cwd: 'I:\\generated',
        projections: { values: { title: '生成会话标题' } },
      },
      { sessionId: 'untitled', updatedAt, running: false, cwd: 'I:\\极简遥控器\\极简遥控器' },
    ]
    try {
      const value = await runTool(toolConfig(), 'list_sessions', {}, {
        signal: new AbortController().signal,
      })
      expect(value.ok).toBe(true)
      const sessions = value.sessions as Array<Record<string, unknown>>
      const ids = sessions.map((session) => session.sessionId)
      expect(ids).not.toContain('blank')
      expect(ids).not.toContain('generated')
      expect(sessions.find((session) => session.sessionId === 'remote-1')?.hasTitle).toBe(true)
      const untitled = sessions.find((session) => session.sessionId === 'untitled')
      expect(untitled?.hasTitle).toBe(false)
      expect(untitled?.name).toBe('极简遥控器')
    } finally {
      world.roster = savedRoster
    }
  })
})

