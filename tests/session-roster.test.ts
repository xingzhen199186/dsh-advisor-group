import { describe, expect, it } from 'vitest'

import {
  buildSessionRoster,
  renderRoster,
  type RosterRow,
  type RosterSource,
} from '../src/session-roster'

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

function source(overrides: Partial<RosterSource> = {}): RosterSource {
  return {
    sessionId: 'session-1',
    updatedAt: Date.now(),
    running: false,
    cwd: 'I:\\demo',
    ...overrides,
  }
}

describe('buildSessionRoster', () => {
  it('uses the host plain-string title and trims it', () => {
    const rows = buildSessionRoster([source({ projections: { values: { title: '  修插件  ' } } })])
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('修插件')
  })

  it('accepts the legacy { title } wrapper', () => {
    const rows = buildSessionRoster([
      source({ projections: { values: { title: { title: ' 旧版标题 ' } } } }),
    ])
    expect(rows[0].name).toBe('旧版标题')
  })

  it('falls back to cwd + ISO time, or the unknown-directory label', () => {
    const updatedAt = Date.UTC(2023, 10, 14, 22, 13, 20)
    const withCwd = buildSessionRoster([source({ cwd: 'I:\\demo', updatedAt })])
    expect(withCwd[0].name).toBe(`I:\\demo · ${new Date(updatedAt).toISOString()}`)
    const withoutCwd = buildSessionRoster([source({ cwd: undefined, updatedAt })])
    expect(withoutCwd[0].name).toBe(`（未知工作目录） · ${new Date(updatedAt).toISOString()}`)
  })

  it('flags subagent origins only', () => {
    const rows = buildSessionRoster([
      source({ sessionId: 'sub', origin: 'subagent' }),
      source({ sessionId: 'ordinary' }),
    ])
    expect(rows.map((row) => [row.sessionId, row.subagent])).toEqual([
      ['sub', true],
      ['ordinary', false],
    ])
  })

  it('matches the query over the name, case-insensitively', () => {
    const rows = buildSessionRoster(
      [
        source({ sessionId: 'a', projections: { values: { title: 'Alpha Session' } } }),
        source({ sessionId: 'b', projections: { values: { title: 'Beta Session' } } }),
      ],
      { query: 'ALPHA' },
    )
    expect(rows.map((row) => row.sessionId)).toEqual(['a'])
  })

  it('matches the query over cwd, and a blank query filters nothing', () => {
    const sessions = [
      source({ sessionId: 'a', cwd: 'I:\\极简遥控器' }),
      source({ sessionId: 'b', cwd: 'I:\\other' }),
    ]
    expect(buildSessionRoster(sessions, { query: '极简' }).map((row) => row.sessionId)).toEqual(['a'])
    expect(buildSessionRoster(sessions, { query: '   ' })).toHaveLength(2)
    expect(buildSessionRoster(sessions, { query: 'zzz' })).toHaveLength(0)
  })

  it('orders running sessions first, then updatedAt descending', () => {
    const now = Date.now()
    const rows = buildSessionRoster([
      source({ sessionId: 'idle-new', updatedAt: now - MINUTE }),
      source({ sessionId: 'run-old', updatedAt: now - 2 * DAY, running: true }),
      source({ sessionId: 'idle-old', updatedAt: now - 3 * DAY }),
      source({ sessionId: 'run-new', updatedAt: now - HOUR, running: true }),
    ])
    expect(rows.map((row) => row.sessionId)).toEqual(['run-new', 'run-old', 'idle-new', 'idle-old'])
  })

  it('caps rows at 30 by default and clamps an explicit limit to 1..50', () => {
    const now = Date.now()
    const many = Array.from({ length: 60 }, (_, index) =>
      source({ sessionId: `s-${index}`, updatedAt: now - index * MINUTE }),
    )
    expect(buildSessionRoster(many)).toHaveLength(30)
    expect(buildSessionRoster(many, { limit: 0 })).toHaveLength(1)
    expect(buildSessionRoster(many, { limit: 999 })).toHaveLength(50)
  })

  it('never throws on malformed rows', () => {
    const malformed = [
      null,
      {},
      { sessionId: 42, updatedAt: 'yesterday', running: 'yes', cwd: 7, projections: { values: { title: 9 } } },
    ] as unknown as RosterSource[]
    expect(() => buildSessionRoster(malformed)).not.toThrow()
    const rows = buildSessionRoster(malformed)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      sessionId: '',
      name: '（未知工作目录）',
      running: false,
      subagent: false,
      updatedAt: 0,
      hint: '（未知工作目录） · （未知时间）',
    })
    expect(rows[1].name).toBe('（未知工作目录）')
  })

  it('builds a short Chinese recency hint', () => {
    const now = Date.now()
    const rows = buildSessionRoster([
      source({ sessionId: 'just', updatedAt: now - 5_000 }),
      source({ sessionId: 'minutes', updatedAt: now - 2 * MINUTE - 5_000 }),
      source({ sessionId: 'hours', updatedAt: now - 3 * HOUR - 5_000 }),
      source({ sessionId: 'days', updatedAt: now - 2 * DAY - 5_000 }),
      source({ sessionId: 'long', cwd: `I:\\${'x'.repeat(80)}` }),
    ])
    const hintOf = (sessionId: string): string => rows.find((row) => row.sessionId === sessionId)?.hint ?? ''
    expect(hintOf('just')).toBe('I:\\demo · 刚刚')
    expect(hintOf('minutes')).toBe('I:\\demo · 2 分钟前')
    expect(hintOf('hours')).toBe('I:\\demo · 3 小时前')
    expect(hintOf('days')).toBe('I:\\demo · 2 天前')
    for (const row of rows) expect(row.hint.length).toBeLessThanOrEqual(40)
  })
})

describe('renderRoster', () => {
  const rows: RosterRow[] = [
    {
      sessionId: 'a',
      name: '修插件',
      cwd: 'I:\\demo',
      updatedAt: Date.now(),
      running: true,
      subagent: false,
      hint: 'I:\\demo · 刚刚',
    },
    {
      sessionId: 'b',
      name: '旧会话',
      updatedAt: Date.now(),
      running: false,
      subagent: true,
      hint: '（未知工作目录） · 2 天前',
    },
  ]

  it('renders a heading, one line per row, and the state flags', () => {
    expect(renderRoster(rows)).toBe(
      ['共 2 个会话', '- 修插件 — I:\\demo · 刚刚 · 运行中', '- 旧会话 — （未知工作目录） · 2 天前 · 子代理'].join(
        '\n',
      ),
    )
  })

  it('renders the empty notice and the filtered heading', () => {
    expect(renderRoster([])).toBe('没有匹配的会话。')
    expect(renderRoster([rows[0]], { filtered: true })).toBe(
      ['匹配 1 个会话', '- 修插件 — I:\\demo · 刚刚 · 运行中'].join('\n'),
    )
  })
})
