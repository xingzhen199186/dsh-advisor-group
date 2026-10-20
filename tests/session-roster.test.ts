import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  buildSessionRoster,
  isNoiseSession,
  NOISE_TITLE_PATTERN,
  renderRoster,
  sessionLogSizes,
  shortSessionName,
  withSessionLogSizes,
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

  it('reports hasTitle: true only when the host published a real title', () => {
    const rows = buildSessionRoster([
      source({ sessionId: 'titled', projections: { values: { title: '真标题' } } }),
      source({ sessionId: 'untitled' }),
    ])
    const flags = rows.map((row) => [row.sessionId, row.hasTitle])
    expect(flags).toEqual([
      ['titled', true],
      ['untitled', false],
    ])
  })

  it('drops blank sessions and title-generation leftovers', () => {
    const rows = buildSessionRoster([
      source({ sessionId: 'blank', blank: true, projections: { values: { title: '看起来正常的标题' } } }),
      source({ sessionId: 'generated', projections: { values: { title: '生成会话标题' } } }),
      source({ sessionId: 'greeting', projections: { values: { title: '你好，' } } }),
      source({ sessionId: 'real', projections: { values: { title: '你好世界' } } }),
    ])
    expect(rows.map((row) => row.sessionId)).toEqual(['real'])
    // The exclusion list is one exported constant, so tests can pin it.
    expect(NOISE_TITLE_PATTERN.test('生成会话标题')).toBe(true)
    expect(NOISE_TITLE_PATTERN.test('你好')).toBe(true)
    expect(NOISE_TITLE_PATTERN.test('你好， ')).toBe(true)
    expect(NOISE_TITLE_PATTERN.test('你好世界')).toBe(false)
    expect(isNoiseSession({ blank: true })).toBe(true)
    expect(isNoiseSession({ projections: { values: { title: '生成会话标题' } } })).toBe(true)
    expect(isNoiseSession({ sessionId: 'self' }, 'self')).toBe(true)
    expect(isNoiseSession({ sessionId: 'self' }, 'other')).toBe(false)
  })

  it('hides subagent rows only when asked to', () => {
    const sessions = [source({ sessionId: 'main' }), source({ sessionId: 'sub', origin: 'subagent' })]
    expect(buildSessionRoster(sessions, { hideSubagents: true }).map((row) => row.sessionId)).toEqual(['main'])
    expect(buildSessionRoster(sessions).map((row) => row.sessionId).sort()).toEqual(['main', 'sub'])
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

describe('shortSessionName', () => {
  const stamp = '2023-11-14T22:13:20.000Z'

  it('turns the fallback label into the last path segment', () => {
    const name = `I:\\极简遥控器\\极简遥控器 · ${stamp}`
    expect(shortSessionName(name, 'I:\\极简遥控器\\极简遥控器')).toBe('极简遥控器')
    // Without cwd the drive-rooted shape is still recognised.
    expect(shortSessionName(name)).toBe('极简遥控器')
  })

  it('leaves real titles alone, even ones containing a middle dot', () => {
    expect(shortSessionName('修插件', 'I:\\demo')).toBe('修插件')
    expect(shortSessionName(`修插件 · ${stamp}`, 'I:\\demo')).toBe(`修插件 · ${stamp}`)
    expect(shortSessionName('')).toBe('')
  })

  it('adds 未命名 when the last segment names nothing', () => {
    expect(shortSessionName(`I: · ${stamp}`, 'I:')).toBe('I: · 未命名')
    expect(shortSessionName(`I:\\ · ${stamp}`, 'I:\\')).toBe('I: · 未命名')
    expect(shortSessionName(`/ · ${stamp}`, '/')).toBe('未命名')
  })

  it('leaves the unknown-directory fallback alone', () => {
    expect(shortSessionName(`（未知工作目录） · ${stamp}`)).toBe(`（未知工作目录） · ${stamp}`)
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
      hasTitle: true,
    },
    {
      sessionId: 'b',
      name: '旧会话',
      updatedAt: Date.now(),
      running: false,
      subagent: true,
      hint: '（未知工作目录） · 2 天前',
      hasTitle: true,
    },
  ]

  it('renders a heading, one line per row, and the state flags', () => {
    expect(renderRoster(rows)).toBe(
      [
        '共 2 个会话',
        '- 修插件 · a — I:\\demo · 刚刚 · 运行中',
        '- 旧会话 · b — （未知工作目录） · 2 天前 · 子代理',
      ].join('\n'),
    )
  })

  it('puts the sessionId on every line so identical titles stay distinguishable', () => {
    const rendered = renderRoster(rows)
    expect(rendered).toContain('· a —')
    expect(rendered).toContain('· b —')
  })

  it('renders the empty notice and the filtered heading', () => {
    expect(renderRoster([])).toBe('没有匹配的会话。')
    expect(renderRoster([rows[0]], { filtered: true })).toBe(
      ['匹配 1 个会话', '- 修插件 · a — I:\\demo · 刚刚 · 运行中'].join('\n'),
    )
  })

  it('keeps hasTitle out of the model-facing text', () => {
    expect(renderRoster(rows)).not.toContain('hasTitle')
  })

  it('shows a title-less session by its last path segment, not the whole path twice', () => {
    const titleless = buildSessionRoster([source({ cwd: 'I:\\极简遥控器\\极简遥控器', updatedAt: Date.now() })])
    expect(renderRoster(titleless)).toBe(
      ['共 1 个会话', '- 极简遥控器 · session-1 — I:\\极简遥控器\\极简遥控器 · 刚刚'].join('\n'),
    )
  })
})

// ---------------------------------------------------------------------------
// Accumulated-context hint: the size of a session's own log
// ---------------------------------------------------------------------------
describe('sizeHint — session log probe', () => {
  let home: string
  let savedHome: string | undefined

  beforeEach(() => {
    savedHome = process.env.DSH_HOME
    home = mkdtempSync(join(tmpdir(), 'advisor-group-roster-size-'))
    process.env.DSH_HOME = home
  })

  afterEach(() => {
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    rmSync(home, { recursive: true, force: true })
  })

  function writeLog(relative: string, bytes: number): void {
    const file = join(home, relative)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, 'x'.repeat(bytes))
  }

  it('reads the nested layout (cwd group / session id / log)', () => {
    writeLog('sessions/--I-proj--/sess-1/session.v4.jsonl.zstd', 42)
    const rows = buildSessionRoster([source({ sessionId: 'sess-1' })])
    expect(rows[0].sizeHint).toBe(42)
  })

  it('reads flat log names, with or without the host prefix and compression', () => {
    writeLog('sessions/sess-2.jsonl', 7)
    expect(buildSessionRoster([source({ sessionId: 'sess-2' })])[0].sizeHint).toBe(7)
    writeLog('sessions/session-sess-3.jsonl.zstd', 9)
    expect(buildSessionRoster([source({ sessionId: 'sess-3' })])[0].sizeHint).toBe(9)
    writeLog('sessions/sess-4-run-2.jsonl', 5)
    expect(sessionLogSizes(['sess-4']).get('sess-4')).toBe(5)
  })

  it('leaves sizeHint undefined and never throws when the layout is unknown', () => {
    expect(buildSessionRoster([source({ sessionId: 'nope' })])[0].sizeHint).toBeUndefined()
    // Corrupt root: `sessions` is a file rather than a directory.
    writeFileSync(join(home, 'sessions'), 'not a directory')
    expect(() => buildSessionRoster([source({ sessionId: 'nope' })])).not.toThrow()
    expect(buildSessionRoster([source({ sessionId: 'nope' })])[0].sizeHint).toBeUndefined()
    expect(sessionLogSizes(['nope']).size).toBe(0)
    expect(() => sessionLogSizes(undefined as never)).not.toThrow()
    expect(() => withSessionLogSizes([null as never, 42 as never])).not.toThrow()
  })

  it('prefers a caller-provided sizeBytes over the probe', () => {
    writeLog('sessions/--I-proj--/sess-5/session.v4.jsonl.zstd', 3)
    const rows = buildSessionRoster([source({ sessionId: 'sess-5', sizeBytes: 9999 })])
    expect(rows[0].sizeHint).toBe(9999)
  })

  it('attaches sizeBytes once per batch and leaves pre-sized rows untouched', () => {
    writeLog('sessions/--I-proj--/sess-6/session.v4.jsonl.zstd', 3)
    const sized = withSessionLogSizes([source({ sessionId: 'sess-6' })])
    expect(sized[0].sizeBytes).toBe(3)
    const known = { ...source({ sessionId: 'sess-7' }), sizeBytes: 5 }
    expect(withSessionLogSizes([known])[0]).toBe(known)
    expect(withSessionLogSizes([source({ sessionId: 'sess-8' })])[0].sizeBytes).toBeUndefined()
  })

  it('prefers the plain log over its compressed sibling and ignores junk names', () => {
    writeLog('sessions/--I-proj--/sess-9/session.v4.jsonl.zstd', 5)
    writeLog('sessions/--I-proj--/sess-9/session.v4.jsonl', 11)
    writeLog('sessions/--I-proj--/sess-9/notes.txt', 100)
    expect(sessionLogSizes(['sess-9']).get('sess-9')).toBe(11)
    // A matching session directory whose log cannot be recognised stays unknown.
    writeLog('sessions/--I-proj--/sess-10/transcript.bin', 50)
    expect(sessionLogSizes(['sess-10']).get('sess-10')).toBeUndefined()
  })
})
