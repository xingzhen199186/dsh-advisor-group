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
  appendCrossSessionHint,
  applyJevDecision,
  clearCrossSessionHints,
  clearRouteCache,
  crossSessionHintForTurn,
  crossSessionSuggestionLine,
  loadAliases,
  normalizeAliasKey,
  rememberCrossSessionHint,
  ROUTE_MIN_CONTEXT_BYTES,
  routeSessions,
  routeSessionsWithEngine,
  saveAlias,
  shouldConsiderCrossSession,
  takeCrossSessionHint,
  type RouteCandidate,
} from '../src/session-router'
import type { RosterSource } from '../src/session-roster'
import type { Config as ConfigShape, JevConfig } from '../src/config'
import { registerAdvisorTools } from '../src/tools'
import type { AdvisorGroupService } from '../src/service'
import { writeAskRecord } from '../src/ask-store'
import { askStoreRoot } from '../src/cross-session'

/** Fixed roster clock: time is an input of the router, never read from the wall clock. */
const BASE = 1_700_000_000_000

// The route cache and the pending-hint store are module state: every case
// starts from an empty one.
beforeEach(() => {
  clearRouteCache()
  clearCrossSessionHints()
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
    // 100 B is below the substantive-context floor, so the newer row is
    // demoted behind the substantive one; the bigger row also claims 积累多
    // because its size separates the two inside one band and project.
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
        // Both clear the substantive-context floor: only the magnitude is at
        // stake, and cross-project magnitudes stay incomparable.
        row('small-here', 'alpha beta', { cwd: 'I:\\proj', updatedAt: BASE + 10_000, sizeBytes: 900_000 }),
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

  // Live regression (2026-10-18): a 14-day-old 冷 session outranked a
  // 2-hour-old 温 one only because it held far more context. Both rows clear the
  // substantive-context floor here, so freshness bands come first; size only
  // orders two rows inside the same band.
  it('never lets a bigger context outrank a fresher recency band', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(BASE)
      const candidates = routeSessions(
        [
          row('cold-big', 'alpha beta', {
            cwd: 'I:\\proj',
            updatedAt: BASE - 14 * ONE_DAY,
            sizeBytes: 9_000_000,
          }),
          row('warm-small', 'alpha beta', {
            cwd: 'I:\\proj',
            updatedAt: BASE - 2 * ONE_HOUR,
            sizeBytes: 900_000,
          }),
        ],
        'alpha beta',
        { topN: 8, cache: false },
      )
      expect(ids(candidates)).toEqual(['warm-small', 'cold-big'])
      // Size did not decide anything here, so no row claims 积累多.
      for (const candidate of candidates) expect(candidate.reason).not.toContain('积累多')
      expect(candidates[0].reason).toContain(' · 温')
      expect(candidates[1].reason).toContain(' · 冷')
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets the larger known size decide inside one recency band', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(BASE)
      const candidates = routeSessions(
        [
          // Both 热 and both above the floor: the band ties, so the bigger
          // context wins.
          row('big-older', 'alpha beta', {
            cwd: 'I:\\proj',
            updatedAt: BASE - 30 * 60_000,
            sizeBytes: 900_000,
          }),
          row('small-newer', 'alpha beta', {
            cwd: 'I:\\proj',
            updatedAt: BASE - 60_000,
            sizeBytes: 500_000,
          }),
        ],
        'alpha beta',
        { topN: 8, cache: false },
      )
      expect(ids(candidates)).toEqual(['big-older', 'small-newer'])
      expect(candidates[0].reason).toContain('积累多')
      expect(candidates[1].reason).not.toContain('积累多')
      expect(candidates[0].reason).toContain(' · 热')
      expect(candidates[1].reason).toContain(' · 热')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a running session above a fresher idle one', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(BASE)
      const candidates = routeSessions(
        [
          row('busy-cold', 'alpha beta', {
            cwd: 'I:\\proj',
            running: true,
            updatedAt: BASE - 30 * ONE_DAY,
          }),
          row('idle-hot', 'alpha beta', {
            cwd: 'I:\\proj',
            updatedAt: BASE - 60_000,
            sizeBytes: 9_000_000,
          }),
        ],
        'alpha beta',
        { topN: 8, cache: false },
      )
      // Running outranks both the fresher band and the bigger context.
      expect(ids(candidates)).toEqual(['busy-cold', 'idle-hot'])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('routeSessions — substantive-context floor', () => {
  it('exports a non-zero substantive-context floor', () => {
    expect(Number.isFinite(ROUTE_MIN_CONTEXT_BYTES)).toBe(true)
    expect(ROUTE_MIN_CONTEXT_BYTES).toBeGreaterThan(0)
  })

  it('sorts a thin but warm row behind a substantive cold one', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(BASE)
      const candidates = routeSessions(
        [
          // 温, but its log is below the floor.
          row('thin-warm', 'alpha beta', {
            cwd: 'I:\\proj',
            updatedAt: BASE - 2 * ONE_HOUR,
            sizeBytes: ROUTE_MIN_CONTEXT_BYTES - 1,
          }),
          // 冷, but it has accumulated real context.
          row('solid-cold', 'alpha beta', {
            cwd: 'I:\\proj',
            updatedAt: BASE - 3 * ONE_DAY,
            sizeBytes: ROUTE_MIN_CONTEXT_BYTES * 4,
          }),
        ],
        'alpha beta',
        { topN: 8, cache: false },
      )
      expect(ids(candidates)).toEqual(['solid-cold', 'thin-warm'])
      // The bands still describe the rows; they just do not decide the order.
      expect(candidates[0].reason).toContain(' · 冷')
      expect(candidates[1].reason).toContain(' · 温')
      expect(candidates[0].reason).not.toContain('体积小')
      expect(candidates[1].reason).toContain('体积小')
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats an unknown size as substantive, never thin', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(BASE)
      const candidates = routeSessions(
        [
          // No probe result: an old unknown row must not be punished for the miss.
          row('unknown-cold', 'alpha beta', { cwd: 'I:\\proj', updatedAt: BASE - 30 * ONE_DAY }),
          // Same project, much fresher, but below the floor.
          row('thin-hot', 'alpha beta', {
            cwd: 'I:\\proj',
            updatedAt: BASE - 60_000,
            sizeBytes: ROUTE_MIN_CONTEXT_BYTES - 1,
          }),
        ],
        'alpha beta',
        { topN: 8, cache: false },
      )
      expect(ids(candidates)).toEqual(['unknown-cold', 'thin-hot'])
      expect(candidates[0].reason).not.toContain('体积小')
      expect(candidates[1].reason).toContain('体积小')
    } finally {
      vi.useRealTimers()
    }
  })

  it('adds 体积小 only to the rows the floor demotes', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(BASE)
      const candidates = routeSessions(
        [
          row('solid', 'alpha beta', {
            cwd: 'I:\\proj',
            updatedAt: BASE - 50 * 60_000,
            sizeBytes: ROUTE_MIN_CONTEXT_BYTES * 4,
          }),
          row('unknown', 'alpha beta', { cwd: 'I:\\proj', updatedAt: BASE - 30 * 60_000 }),
          row('thin', 'alpha beta', {
            cwd: 'I:\\proj',
            updatedAt: BASE - 60_000,
            sizeBytes: 1_000,
          }),
        ],
        'alpha beta',
        { topN: 8, cache: false },
      )
      // All 热: the substantive pair keeps its recency order, the thin row drops
      // behind both of them.
      expect(ids(candidates)).toEqual(['unknown', 'solid', 'thin'])
      const reasonOf = (sessionId: string): string =>
        candidates.find((candidate) => candidate.sessionId === sessionId)?.reason ?? ''
      expect(reasonOf('unknown')).not.toContain('体积小')
      expect(reasonOf('solid')).not.toContain('体积小')
      expect(reasonOf('thin')).toContain('体积小')
      for (const candidate of candidates) expect(candidate.reason).toContain(' · 热')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the live fixture titled row ahead of the throwaway 询问顾问群项目开发进度', () => {
    // Measured log sizes: the long-running titled row is 27,436,715 B; the
    // one-turn throwaway is 118,787 B, below the floor.
    const sessions: RosterSource[] = liveRoster().map((session) =>
      session.sessionId === 'titled-main' ? { ...session, sizeBytes: 27_436_715 } : session,
    )
    sessions.push({
      sessionId: 'ask-progress',
      updatedAt: BASE - 2 * 60_000,
      running: false,
      cwd: 'I:\\DSH\\dsh-advisor-group',
      sizeBytes: 118_787,
      projections: { values: { title: '询问顾问群项目开发进度' } },
    })
    const all = routeSessions(sessions, LIVE_QUESTION, { topN: 8, cache: false })
    const titled = all.findIndex((candidate) => candidate.sessionId === 'titled-main')
    const thin = all.findIndex((candidate) => candidate.sessionId === 'ask-progress')
    expect(titled).toBe(0)
    expect(thin).toBeGreaterThan(titled)
    expect(all[thin].reason).toContain('体积小')
    expect(all[titled].reason).not.toContain('体积小')
  })
})

describe('routeSessions — Jev routing engine', () => {
  /** Three equal-score rows with a fixed local order: freshest first. */
  const sessions = [
    row('fresh', 'alpha beta', { updatedAt: BASE + 2_000 }),
    row('mid', 'alpha beta', { updatedAt: BASE + 1_000 }),
    row('old', 'alpha beta', { updatedAt: BASE }),
  ]

  it('moves a Jev pick above 0.75 to the front and marks it', async () => {
    const candidates = await routeSessionsWithEngine(sessions, 'alpha beta', {
      engine: 'jev',
      cache: false,
      jev: async () => ({ choice: 'old', confidence: 0.9 }),
    })
    expect(ids(candidates)).toEqual(['old', 'fresh', 'mid'])
    expect(candidates[0].reason).toContain('Jev 推荐')
    for (const candidate of candidates.slice(1)) expect(candidate.reason).not.toContain('Jev 推荐')
  })

  it('obeys the 0.75 boundary exactly', async () => {
    const candidates = await routeSessionsWithEngine(sessions, 'alpha beta', {
      engine: 'jev',
      cache: false,
      jev: async () => ({ choice: 'mid', confidence: 0.75 }),
    })
    expect(ids(candidates)).toEqual(['mid', 'fresh', 'old'])
    expect(candidates[0].reason).toContain('Jev 推荐')
  })

  it('keeps the local order inside the 0.45–0.75 band, unmarked', async () => {
    for (const confidence of [0.45, 0.6, 0.74]) {
      const candidates = await routeSessionsWithEngine(sessions, 'alpha beta', {
        engine: 'jev',
        cache: false,
        jev: async () => ({ choice: 'old', confidence }),
      })
      expect(ids(candidates)).toEqual(['fresh', 'mid', 'old'])
      for (const candidate of candidates) expect(candidate.reason).not.toContain('Jev 推荐')
    }
  })

  it('ignores the "none" escape and a below-0.45 confidence', async () => {
    for (const decision of [{ choice: 'none', confidence: 0.99 }, { choice: 'old', confidence: 0.44 }]) {
      const candidates = await routeSessionsWithEngine(sessions, 'alpha beta', {
        engine: 'jev',
        cache: false,
        jev: async () => decision,
      })
      expect(ids(candidates)).toEqual(['fresh', 'mid', 'old'])
      for (const candidate of candidates) expect(candidate.reason).not.toContain('Jev 推荐')
    }
  })

  it('ignores an id outside the option list and a missing confidence', async () => {
    for (const decision of [{ choice: 'not-a-candidate', confidence: 0.99 }, { choice: 'old' }]) {
      const candidates = await routeSessionsWithEngine(sessions, 'alpha beta', {
        engine: 'jev',
        cache: false,
        jev: async () => decision,
      })
      expect(ids(candidates)).toEqual(['fresh', 'mid', 'old'])
    }
  })

  it('falls back to the local order on any Jev failure, without throwing', async () => {
    const failures = [
      async () => {
        throw new Error('Jev 超时（1000ms）')
      },
      async () => {
        throw new Error('Jev HTTP 500')
      },
      async () => {
        throw new SyntaxError('Unexpected token < in JSON')
      },
      async () => undefined,
    ]
    for (const jev of failures) {
      const candidates = await routeSessionsWithEngine(sessions, 'alpha beta', {
        engine: 'jev',
        cache: false,
        jev,
      })
      expect(ids(candidates)).toEqual(['fresh', 'mid', 'old'])
      for (const candidate of candidates) expect(candidate.reason).not.toContain('Jev 推荐')
    }
  })

  it('never calls Jev when the engine is local', async () => {
    let called = false
    const candidates = await routeSessionsWithEngine(sessions, 'alpha beta', {
      engine: 'local',
      cache: false,
      jev: async () => {
        called = true
        return { choice: 'old', confidence: 0.99 }
      },
    })
    expect(called).toBe(false)
    expect(ids(candidates)).toEqual(['fresh', 'mid', 'old'])
  })

  it('behaves like local and says so when Jev is not configured', async () => {
    const candidates = await routeSessionsWithEngine(sessions, 'alpha beta', {
      engine: 'jev',
      cache: false,
    })
    expect(ids(candidates)).toEqual(['fresh', 'mid', 'old'])
    for (const candidate of candidates) expect(candidate.reason).toContain('Jev 未配置')
  })

  it('hands the local list to Jev with the caller-provided English gloss', async () => {
    let seen: { question?: string; questionEn?: string; candidates?: readonly RouteCandidate[] } = {}
    await routeSessionsWithEngine(sessions, 'alpha beta', {
      engine: 'jev',
      cache: false,
      questionEn: 'Which session tracks alpha beta?',
      jev: async (input) => {
        seen = input
        return { choice: 'mid', confidence: 0.9 }
      },
    })
    expect(seen.question).toBe('alpha beta')
    expect(seen.questionEn).toBe('Which session tracks alpha beta?')
    expect(ids(seen.candidates ?? [])).toEqual(['fresh', 'mid', 'old'])
  })

  it('re-orders a known candidate list without inventing options', () => {
    const local: RouteCandidate[] = sessions.map((session) => ({
      sessionId: session.sessionId,
      name: session.sessionId,
      score: 100,
      reason: '本地 · 冷',
    }))
    const picked = applyJevDecision(local, { choice: 'mid', confidence: 0.9 })
    expect(ids(picked)).toEqual(['mid', 'fresh', 'old'])
    expect(picked).toHaveLength(local.length)
    expect(picked[0].reason).toBe('本地 · 冷 · Jev 推荐')
  })
})

describe('shouldConsiderCrossSession', () => {
  it('accepts a turn that points at another session or task', () => {
    expect(shouldConsiderCrossSession('帮我去问一下那个会话的进度')).toBe(true)
    expect(shouldConsiderCrossSession('上个会话说过的话题，现在什么状态')).toBe(true)
    expect(shouldConsiderCrossSession('I:\\DSH\\dsh-advisor-group 的构建脚本改了吗')).toBe(true)
    expect(shouldConsiderCrossSession('dsh-advisor-group 最近有什么改动')).toBe(true)
  })

  it('rejects a self-contained turn', () => {
    expect(shouldConsiderCrossSession('帮我把这句话改得通顺一点')).toBe(false)
    expect(shouldConsiderCrossSession('今天天气怎么样')).toBe(false)
    expect(shouldConsiderCrossSession('   ')).toBe(false)
    expect(shouldConsiderCrossSession(undefined as never)).toBe(false)
  })

  it('rejects a turn that already names an explicit target', () => {
    expect(shouldConsiderCrossSession('问一下「极简遥控器新」会话的进度')).toBe(false)
    expect(shouldConsiderCrossSession('发到 session-76243a21-a1cc-495f-84a3-80f3c47889aa 的进度')).toBe(false)
    expect(shouldConsiderCrossSession('用 ask_session 把这个问题发给那个会话')).toBe(false)
  })
})

describe('cross-session suggestion (Jev)', () => {
  const TEXT = '帮我去问一下那个会话的进度'
  const candidates: RouteCandidate[] = [
    { sessionId: 'session-a', name: '极简遥控器新', score: 90, reason: '标题命中 · 温' },
    { sessionId: 'session-b', name: '顾问群插件', score: 80, reason: '目录命中 · 冷' },
  ]
  const confidencePick = {
    askConfidence: 0.8,
    pick: 'session-a',
    pickConfidence: 0.8,
    sensitiveConfidence: 0.1,
  }

  it('returns the one-turn hint for a confident, non-sensitive pick', async () => {
    const hint = await crossSessionHintForTurn({
      text: TEXT,
      mode: 'gated',
      candidates,
      judge: async () => confidencePick,
    })
    expect(hint).toBe('「这件事可能更适合问：极简遥控器新（ask_session）」')
  })

  it('never calls Jev in off mode', async () => {
    let called = false
    const hint = await crossSessionHintForTurn({
      text: TEXT,
      mode: 'off',
      candidates,
      judge: async () => {
        called = true
        return confidencePick
      },
    })
    expect(called).toBe(false)
    expect(hint).toBeUndefined()
  })

  it('gated mode skips Jev when the prefilter says no; always mode does not', async () => {
    let called = false
    const gated = await crossSessionHintForTurn({
      text: '帮我把这句话改得通顺一点',
      mode: 'gated',
      candidates,
      judge: async () => {
        called = true
        return confidencePick
      },
    })
    expect(called).toBe(false)
    expect(gated).toBeUndefined()
    const always = await crossSessionHintForTurn({
      text: '帮我把这句话改得通顺一点',
      mode: 'always',
      candidates,
      judge: async () => confidencePick,
    })
    expect(always).toBe('「这件事可能更适合问：极简遥控器新（ask_session）」')
  })

  it('stays silent below 0.6, on "none", an unknown id, or a sensitive question', async () => {
    const silent = [
      { askConfidence: 0.59, pick: 'session-a', sensitiveConfidence: 0.1 },
      { askConfidence: 0.9, pick: 'none', sensitiveConfidence: 0.1 },
      { askConfidence: 0.9, pick: 'not-a-candidate', sensitiveConfidence: 0.1 },
      { askConfidence: 0.9, pick: 'session-a', sensitiveConfidence: 0.6 },
    ]
    for (const judgment of silent) {
      const hint = await crossSessionHintForTurn({
        text: TEXT,
        mode: 'always',
        candidates,
        judge: async () => judgment,
      })
      expect(hint).toBeUndefined()
    }
  })

  it('never throws and stays silent on any judge failure', async () => {
    const failures = [
      async () => {
        throw new Error('Jev 超时（1000ms）')
      },
      async () => {
        throw new Error('Jev HTTP 500')
      },
      async () => {
        throw new SyntaxError('bad json')
      },
      async () => undefined,
    ]
    for (const judge of failures) {
      await expect(crossSessionHintForTurn({ text: TEXT, mode: 'always', candidates, judge })).resolves.toBeUndefined()
    }
  })

  it('stays silent without candidates or a configured client', async () => {
    expect(
      await crossSessionHintForTurn({ text: TEXT, mode: 'always', candidates: [], judge: async () => confidencePick }),
    ).toBeUndefined()
    expect(await crossSessionHintForTurn({ text: TEXT, mode: 'always', candidates })).toBeUndefined()
  })

  it('builds the suggestion line from the picked candidate only', () => {
    expect(crossSessionSuggestionLine(confidencePick, candidates)).toBe(
      '「这件事可能更适合问：极简遥控器新（ask_session）」',
    )
    expect(crossSessionSuggestionLine(undefined, candidates)).toBeUndefined()
  })
})

describe('cross-session hint store', () => {
  it('is consumed by exactly one prompt assembly', () => {
    rememberCrossSessionHint('session-1', '「这件事可能更适合问：极简遥控器新（ask_session）」')
    const first = appendCrossSessionHint('BASE', 'session-1')
    expect(first).toContain('这件事可能更适合问')
    const second = appendCrossSessionHint('BASE', 'session-1')
    expect(second).toBe('BASE')
  })

  it('stands alone when the base prompt is empty', () => {
    rememberCrossSessionHint('session-2', '「hint」')
    expect(appendCrossSessionHint('', 'session-2')).toBe('「hint」')
    expect(appendCrossSessionHint('', 'session-2')).toBe('')
  })

  it('keeps hints per session and ignores empty input', () => {
    rememberCrossSessionHint('a', 'hint-a')
    rememberCrossSessionHint('', 'ignored')
    rememberCrossSessionHint('b', '   ')
    expect(takeCrossSessionHint('a')).toBe('hint-a')
    expect(takeCrossSessionHint('a')).toBeUndefined()
    expect(takeCrossSessionHint('b')).toBeUndefined()
    expect(takeCrossSessionHint(undefined)).toBeUndefined()
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

  it('keys the route cache by engine', () => {
    expect(ids(routeSessions([row('a', 'alpha beta')], QUESTION, { engine: 'local' }))).toEqual(['a'])
    // Same question, other engine: its own entry, so the new roster answers.
    expect(ids(routeSessions([row('b', 'alpha beta')], QUESTION, { engine: 'jev' }))).toEqual(['b'])
    // Back to local: the first entry is still live.
    expect(ids(routeSessions([row('c', 'alpha beta')], QUESTION, { engine: 'local' }))).toEqual(['a'])
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

function toolConfig(
  routing: { enabled?: boolean; topN?: number; engine?: 'local' | 'jev'; jev?: JevConfig } = {},
): ConfigShape {
  return {
    enabled: true,
    discussion: {
      maxRounds: 2,
      maxAdvisorsPerCall: 3,
      parallel: true,
      autoDeepen: true,
      stopOnConsensus: false,
    },
    trigger: {
      requireClassifier: true,
      allowWebFallback: true,
      confidenceThreshold: 0.6,
      ...(routing.jev === undefined ? {} : { jev: routing.jev }),
    },
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
      routingEngine: routing.engine ?? 'local',
    },
    advisors: [],
  }
}

/** Configured Jev credentials (routing reuses the trigger Jev block). */
function jevConfig(): JevConfig {
  return {
    enabled: false,
    provider: 'typesafe',
    model: 'jev-latest',
    apiKey: 'test-key',
    timeoutMs: 1000,
    confidenceThreshold: 0.6,
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
    vi.restoreAllMocks()
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

  it('lets Jev move its pick to the front when the routing engine is jev', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ answers: { route: { choice: 'remote-1', confidence: 0.9 } } }), { status: 200 }),
    )
    const value = await runTool(
      toolConfig({ engine: 'jev', jev: jevConfig(), topN: 3 }),
      'ask_session',
      { question: '遥控器 顾问群 插件', questionEn: 'Which session owns the advisor-group plugin work?' },
      selfExec(),
    )
    const candidates = value.routeCandidates as RouteCandidate[]
    // The local scorer put remote-2 first; Jev's confident pick takes the top.
    expect(candidates.map((candidate) => candidate.sessionId)).toEqual(['remote-1', 'remote-2'])
    expect(candidates[0].reason).toContain('Jev 推荐')
    expect(candidates[1].reason).not.toContain('Jev 推荐')
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      state: string
      questions: { route: { type: string, criteria: Record<string, string> } }
    }
    expect(body.questions.route.type).toBe('choice')
    expect(Object.keys(body.questions.route.criteria)).toEqual(
      expect.arrayContaining(['remote-1', 'remote-2', 'none']),
    )
    // Candidate titles stay in their original Chinese.
    expect(body.questions.route.criteria['remote-1']).toContain('极简遥控器改造')
    expect(body.state).toContain('Which session owns the advisor-group plugin work?')
    expect(body.state).toContain('遥控器 顾问群 插件')
  })

  it('never calls Jev when the routing engine is local', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ answers: { route: { choice: 'remote-1', confidence: 0.9 } } }), { status: 200 }),
    )
    const value = await runTool(
      toolConfig({ engine: 'local', jev: jevConfig() }),
      'ask_session',
      { question: '遥控器 顾问群 插件' },
      selfExec(),
    )
    expect(fetchMock).not.toHaveBeenCalled()
    const candidates = value.routeCandidates as RouteCandidate[]
    for (const candidate of candidates) expect(candidate.reason).not.toContain('Jev 推荐')
  })

  it('behaves like local and says so when Jev is not configured', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ answers: { route: { choice: 'remote-1', confidence: 0.9 } } }), { status: 200 }),
    )
    const value = await runTool(
      toolConfig({ engine: 'jev' }),
      'ask_session',
      { question: '遥控器 顾问群 插件' },
      selfExec(),
    )
    expect(fetchMock).not.toHaveBeenCalled()
    const candidates = value.routeCandidates as RouteCandidate[]
    expect(candidates.map((candidate) => candidate.sessionId)).toEqual(['remote-2', 'remote-1'])
    for (const candidate of candidates) expect(candidate.reason).toContain('Jev 未配置')
  })

  it('falls back to the local order when the Jev call fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Jev 超时（1000ms）'))
    const value = await runTool(
      toolConfig({ engine: 'jev', jev: jevConfig() }),
      'ask_session',
      { question: '遥控器 顾问群 插件' },
      selfExec(),
    )
    const candidates = value.routeCandidates as RouteCandidate[]
    expect(candidates.map((candidate) => candidate.sessionId)).toEqual(['remote-2', 'remote-1'])
    for (const candidate of candidates) expect(candidate.reason).not.toContain('Jev 推荐')
  })

  it('falls back to the local order on an unparseable Jev response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    const value = await runTool(
      toolConfig({ engine: 'jev', jev: jevConfig() }),
      'ask_session',
      { question: '遥控器 顾问群 插件' },
      selfExec(),
    )
    const candidates = value.routeCandidates as RouteCandidate[]
    expect(candidates.map((candidate) => candidate.sessionId)).toEqual(['remote-2', 'remote-1'])
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

