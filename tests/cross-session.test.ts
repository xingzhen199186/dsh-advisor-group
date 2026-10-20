import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The real @deepseek-ai/dsh-tools pulls @deepseek-ai/dsh-sandbox, a host peer
// that is not installed here (same reason tests/tools-schema.test.ts mocks it).
vi.mock('@deepseek-ai/dsh-tools', () => ({
  defineTool: (options: unknown) => options,
}))

import {
  ARCHIVED_SESSION_MESSAGE,
  ASK_CONTENT_MAX_BYTES,
  ASK_HOP_LIMIT,
  ASK_WAIT_DEFAULT_MS,
  ASK_WAIT_MAX_MS,
  archivedSessionIds,
  askContentBytes,
  askSession,
  askStatus,
  buildAskEnvelope,
  buildAskMessage,
  cancelDetachedAsks,
  candidateLine,
  CANDIDATE_DISPLAY_LIMIT,
  checkAskGuards,
  collectAnswer,
  deliveryWatermark,
  fallbackSessionName,
  getSessionController,
  inboundAskId,
  isSubagentDeliveryRejection,
  isWaiting,
  joinAnswerPieces,
  logWatermark,
  matchTargetSession,
  nextAskHop,
  normalizeWaitMs,
  parseAskReply,
  probeWaitingBody,
  PROVISIONAL_BODY_LIMIT,
  provisionalBodySection,
  registeredSessionIds,
  renderAskResult,
  renderCandidateBlock,
  resetPendingWaits,
  resetRegistryProbe,
  sessionDisplayName,
  UNREGISTERED_SESSION_MESSAGE,
  waitForTargetIdle,
  type AskCardDelivery,
  type AskCardSettle,
  type CrossSessionAgent,
  type CrossSessionController,
  type CrossSessionLogEvent,
  type CrossSessionSummary,
  type SessionAskMessageSource,
} from '../src/cross-session'
import { ASK_BOOT_ID, askStoreDir, listAskRecords, readAskRecord, type AskRecord } from '../src/ask-store'
import { registerAdvisorTools, renderAskRecords } from '../src/tools'
import { askSessions, type AskSessionsInput } from '../src/multi-ask'
import type { AdvisorGroupService } from '../src/service'

const SELF = 'session-self'
const TARGET = 'session-target'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function textEvent(seq: number, time: number, text: string): CrossSessionLogEvent {
  return {
    type: 'assistant/message',
    seq,
    time,
    data: { message: { content: [{ type: 'text', text }] } },
  }
}

function userEvent(
  seq: number,
  time: number,
  source: Record<string, unknown>,
): CrossSessionLogEvent {
  return {
    type: 'user/message',
    seq,
    time,
    data: { message: { source: { ...source }, content: [{ type: 'text', text: 'hi' }] } },
  } as unknown as CrossSessionLogEvent
}

function summary(overrides: Partial<CrossSessionSummary> & { sessionId: string }): CrossSessionSummary {
  return { updatedAt: 1700000000000, running: false, ...overrides }
}

function titled(sessionId: string, title: string, extra: Partial<CrossSessionSummary> = {}): CrossSessionSummary {
  // The host publishes the `title` projection as a PLAIN STRING
  // (`dsh-session-title`: `z.string().min(1).nullable()`); using the real shape
  // here is what keeps the resolver honest (the wrapper form is covered below).
  return summary({ sessionId, projections: { values: { title } }, ...extra })
}

/**
 * Reports `running: true` for a few milliseconds after creation, then false —
 * so the wait loop observes a real busy → idle transition.
 */
function idleAfterTurn(target: CrossSessionSummary): () => readonly CrossSessionSummary[] {
  const startedAt = Date.now()
  return () => [{ ...target, running: Date.now() - startedAt < 10 }]
}

/** One session-ask source as it lands in a receiver's log. */
function askSource(hop: number): SessionAskMessageSource {
  return { kind: 'session-ask', form: 'relay', askId: 'a1', senderSessionId: 'x', senderName: 'X', hop }
}

interface FakeWorld {
  readonly controller: CrossSessionController
  readonly followup: ReturnType<typeof vi.fn>
  readonly prompt: ReturnType<typeof vi.fn>
  readonly cancel: ReturnType<typeof vi.fn>
  readonly resolveAgent: ReturnType<typeof vi.fn>
}

/**
 * Minimal fake host: delivery succeeds by default, the target looks idle at
 * delivery and settles immediately, and its log is whatever the caller seeds.
 */
function fakeWorld(options: {
  readonly items: readonly CrossSessionSummary[]
  readonly targetEvents?: readonly CrossSessionLogEvent[]
  /** Log as seen when the delivery watermark is read (defaults to targetEvents). */
  readonly watermarkEvents?: () => readonly CrossSessionLogEvent[]
  readonly listItems?: () => readonly CrossSessionSummary[]
}): FakeWorld {
  const followup = vi.fn()
  const prompt = vi.fn(async () => ({ accepted: true }))
  const cancel = vi.fn()
  const targetAgent: CrossSessionAgent = {
    session: {
      id: TARGET,
      header: { cwd: 'C:\\work' },
      snapshotEvents: () => options.watermarkEvents?.() ?? options.targetEvents ?? [],
    },
    followup,
  }
  // After handover the reading seam switches to the full (post-delivery) log.
  const finalAgent: CrossSessionAgent = {
    session: {
      id: TARGET,
      header: { cwd: 'C:\\work' },
      snapshotEvents: () => options.targetEvents ?? [],
    },
    followup,
  }
  let deliveries = 0
  const resolveAgent = vi.fn(async (sessionId: string): Promise<{ readonly agent: CrossSessionAgent } | { readonly error: { readonly code: string } }> => {
    if (sessionId !== TARGET) return { error: { code: 'session/not-found' } }
    return { agent: deliveries === 0 ? targetAgent : finalAgent }
  })
  const controller: CrossSessionController = {
    list: async () => ({ items: options.listItems ? options.listItems() : options.items }),
    resolveAgent,
    prompt: prompt as unknown as CrossSessionController['prompt'],
    // deliberately present so tests can prove it is never called
    ...({ cancel } as unknown as Record<string, never>),
  }
  followup.mockImplementation(() => {
    deliveries += 1
  })
  return { controller, followup, prompt, cancel, resolveAgent }
}

function askInput(world: FakeWorld, overrides: Record<string, unknown> = {}) {
  return {
    ctx: { sessionController: world.controller },
    signal: new AbortController().signal,
    input: {
      currentSessionId: SELF,
      senderName: '提问方',
      currentEvents: [] as readonly CrossSessionLogEvent[],
      target: TARGET,
      question: '那个报错改了吗？',
      waitMs: 30,
      ...overrides,
    },
  }
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

describe('ask envelope', () => {
  it('puts the sender, the question, then optional background, in that order', () => {
    const blocks = buildAskEnvelope('构建会话', '那个报错改了吗？', '报错在 build 第二步')
    expect(blocks).toEqual([
      { type: 'text', text: '【来自会话「构建会话」的提问】' },
      { type: 'text', text: '那个报错改了吗？' },
      { type: 'text', text: '【对方补充的背景】\n报错在 build 第二步' },
    ])
  })

  it('omits the background block entirely when no context is given', () => {
    // Sender + question; no background block.
    expect(buildAskEnvelope('构建会话', '问题')).toHaveLength(2)
    expect(buildAskEnvelope('构建会话', '问题', '   ')).toHaveLength(2)
  })

  it('carries the declared session-ask source on the identified message', () => {
    const source: SessionAskMessageSource = {
      kind: 'session-ask',
      form: 'relay',
      askId: 'ask-1',
      senderSessionId: SELF,
      senderName: '提问方',
      hop: 1,
    }
    const message = buildAskMessage(buildAskEnvelope(source.senderName, 'q'), source)
    expect(message.role).toBe('user')
    expect(typeof message.id).toBe('string')
    expect(message.source).toEqual(source)
    // Compile-time proof that declaration merging into MessageSourceMap works.
    const kind: 'session-ask' = message.source.kind as 'session-ask'
    expect(kind).toBe('session-ask')
  })

  it('sizes the payload in UTF-8 bytes, not code units', () => {
    expect(askContentBytes('abc')).toBe(3)
    expect(askContentBytes('中')).toBe(3)
    expect(askContentBytes('中', '文')).toBe(6)
    expect(ASK_CONTENT_MAX_BYTES).toBe(32000)
  })
})

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

describe('target resolution', () => {
  const sessions = [
    titled('s1', '构建会话'),
    titled('s2', '文档会话', { cwd: 'C:\\docs', updatedAt: 1700000001000 }),
  ]

  it('matches an exact sessionId outright', () => {
    expect(matchTargetSession(sessions, 's2')).toEqual({
      kind: 'unique',
      target: { sessionId: 's2', name: '文档会话' },
    })
  })

  it('matches a unique exact title', () => {
    expect(matchTargetSession(sessions, '构建会话')).toEqual({
      kind: 'unique',
      target: { sessionId: 's1', name: '构建会话' },
    })
  })

  it('returns candidates instead of guessing when a title is ambiguous', () => {
    const ambiguous = [titled('a', '同名'), titled('b', '同名')]
    const match = matchTargetSession(ambiguous, '同名')
    expect(match.kind).toBe('ambiguous')
    if (match.kind !== 'ambiguous') return
    expect(match.candidates.map((candidate) => candidate.sessionId)).toEqual(['a', 'b'])
    expect(match.candidates.every((candidate) => candidate.name === '同名')).toBe(true)
  })

  it('reports missing for no match and an empty reference', () => {
    expect(matchTargetSession(sessions, '不存在的会话').kind).toBe('missing')
    expect(matchTargetSession(sessions, '   ').kind).toBe('missing')
  })

  // 2026-10-03: partial natural names used to return missing, which forced the
  // asking model to dig session ids out of log directories. Now a unique
  // partial hit resolves directly and several hits become candidates.
  it('resolves a unique partial name instead of demanding an exact title', () => {
    expect(matchTargetSession(sessions, '构建')).toEqual({
      kind: 'unique',
      target: { sessionId: 's1', name: '构建会话' },
    })
  })

  it('finds an untitled session by its workspace directory name', () => {
    const target = summary({ sessionId: 'rc', cwd: 'I:\\极简遥控器\\极简遥控器', updatedAt: 2 })
    const other = summary({ sessionId: 'dev', cwd: 'I:\\DSH\\dsh-advisor-group', updatedAt: 1 })
    expect(matchTargetSession([other, target], '极简遥控器')).toEqual({
      kind: 'unique',
      target: { sessionId: 'rc', name: sessionDisplayName(target) },
    })
  })

  it('partial-matches the workspace path case-insensitively', () => {
    expect(matchTargetSession(sessions, 'DOC')).toEqual({
      kind: 'unique',
      target: { sessionId: 's2', name: '文档会话' },
    })
  })

  it('several partial hits become candidates: running first, then most recent', () => {
    const old = summary({ sessionId: 'old', cwd: 'C:\\proj\\alpha-old', updatedAt: 1000 })
    const recent = summary({ sessionId: 'recent', cwd: 'C:\\proj\\alpha-recent', updatedAt: 9000 })
    const live = summary({ sessionId: 'live', cwd: 'C:\\proj\\alpha-live', updatedAt: 500, running: true })
    const match = matchTargetSession([old, recent, live], 'alpha')
    expect(match.kind).toBe('ambiguous')
    if (match.kind !== 'ambiguous') return
    expect(match.candidates.map((candidate) => candidate.sessionId)).toEqual(['live', 'recent', 'old'])
  })

  it('caps broad partial candidate lists at the most recent entries', () => {
    const many = Array.from({ length: 15 }, (_, index) =>
      summary({ sessionId: `s${index}`, cwd: `C:\\shared\\room-${index}`, updatedAt: index }),
    )
    const match = matchTargetSession(many, 'room')
    expect(match.kind).toBe('ambiguous')
    if (match.kind !== 'ambiguous') return
    expect(match.candidates).toHaveLength(10)
    expect(match.candidates[0]?.sessionId).toBe('s14')
  })

  it('falls back to cwd plus activity time when the title projection is absent', () => {
    const bare = summary({ sessionId: 'cold', cwd: 'C:\\work\\cold', updatedAt: 1700000000000 })
    const name = sessionDisplayName(bare)
    expect(name).toContain('C:\\work\\cold')
    expect(name).toContain('2023-11-14')
    // Not a throw, and still resolvable by its sessionId.
    expect(matchTargetSession([bare], 'cold')).toEqual({
      kind: 'unique',
      target: { sessionId: 'cold', name },
    })
  })

  it('still accepts the legacy { title } wrapper', () => {
    const legacy = summary({ sessionId: 'old', projections: { values: { title: { title: '旧形态会话' } } } })
    expect(sessionDisplayName(legacy)).toBe('旧形态会话')
  })

  it('degrades to the fallback for malformed or empty title projections', () => {
    expect(sessionDisplayName(summary({ sessionId: 'x', cwd: 'C:\\w' }))).toContain('C:\\w')
    expect(sessionDisplayName(summary({ sessionId: 'x', projections: { values: { title: null } } }))).toContain(
      '未知工作目录',
    )
    expect(sessionDisplayName(summary({ sessionId: 'x', projections: { values: { title: { nope: 1 } } } }))).toContain(
      '（未知工作目录）',
    )
    expect(fallbackSessionName(undefined, undefined)).toBe('（未知工作目录）')
  })
})

// ---------------------------------------------------------------------------
// Hop count
// ---------------------------------------------------------------------------

describe('hop guard', () => {
  it('counts a fresh question as hop 0', () => {
    expect(nextAskHop([])).toBe(0)
    expect(nextAskHop([userEvent(1, 1, { kind: 'user' })])).toBe(0)
  })

  it('raises the received hop by exactly one', () => {
    expect(nextAskHop([userEvent(1, 1, askSource(0))])).toBe(1)
    expect(nextAskHop([userEvent(1, 1, askSource(1))])).toBe(2)
    expect(nextAskHop([userEvent(1, 1, askSource(2))])).toBe(3)
  })

  it('keeps the relay hop even when a later direct user message arrives', () => {
    const events = [userEvent(1, 1, askSource(1)), textEvent(2, 2, '收到了'), userEvent(3, 3, { kind: 'user' })]
    expect(nextAskHop(events)).toBe(2)
  })

  it('does not throw when a session-ask source carries no numeric hop', () => {
    expect(nextAskHop([userEvent(1, 1, { kind: 'session-ask', form: 'relay' })])).toBe(1)
  })

  it('refuses the third hop but allows the first two', () => {
    const guardsFor = (hop: number) =>
      checkAskGuards({
        guards: { currentSessionId: SELF, hop },
        match: { kind: 'unique', target: { sessionId: TARGET, name: '构建会话' } },
        sessions: [],
        question: 'q',
      })
    expect(ASK_HOP_LIMIT).toBe(2)
    expect(guardsFor(0)).toBeUndefined()
    expect(guardsFor(1)).toBeUndefined()
    expect(guardsFor(2)).toBeUndefined()
    expect(guardsFor(3)?.code).toBe('hop-limit')
  })
})

// ---------------------------------------------------------------------------
// Parent ask trace + swarm exclusion
// ---------------------------------------------------------------------------

describe('parent ask trace', () => {
  it('reads the inbound askId from the newest user message source', () => {
    expect(inboundAskId([])).toBeUndefined()
    expect(inboundAskId([userEvent(1, 1, askSource(1)), textEvent(2, 2, '处理中')])).toBe('a1')
  })

  it('does not guess a parent once a plain human prompt is answered', () => {
    expect(inboundAskId([userEvent(1, 1, askSource(1)), userEvent(2, 2, { kind: 'user' })])).toBeUndefined()
  })

  it('ignores a session-ask source without an askId', () => {
    expect(inboundAskId([userEvent(1, 1, { kind: 'session-ask', form: 'relay' })])).toBeUndefined()
  })
})

describe('swarm exclusion (swarm.routingExclude)', () => {
  const sessions = [titled(TARGET, '目标会话'), titled('session-open', '正常会话')]

  it('refuses an explicit target that resolves to an excluded session', async () => {
    const world = fakeWorld({ items: sessions })
    const { ctx, signal, input } = askInput(world, { target: '目标会话', exclude: ['目标会话'] })
    const value = (await askSession(ctx, signal, input)) as Record<string, unknown>
    expect(value).toMatchObject({
      ok: false,
      error: 'swarm-excluded',
      message: '这个会话被设置为不参与蜂群（设置 → 插件 → 顾问群 → 全局蜂群 → 不参与路由的会话）。',
    })
    expect(world.followup).not.toHaveBeenCalled()
    expect(world.prompt).not.toHaveBeenCalled()
  })

  it('never offers an excluded session as a target-not-found candidate', async () => {
    const world = fakeWorld({ items: sessions })
    const { ctx, signal, input } = askInput(world, { target: '不存在的会话名', exclude: ['目标会话'] })
    const value = (await askSession(ctx, signal, input)) as Record<string, unknown>
    expect(value.error).toBe('target-not-found')
    const candidates = value.candidates as Array<{ sessionId: string }>
    expect(candidates.map((candidate) => candidate.sessionId)).not.toContain(TARGET)
    expect(candidates.map((candidate) => candidate.sessionId)).toContain('session-open')
  })
})

// ---------------------------------------------------------------------------
// Candidate display (sessionId · cwd · age, capped list)
// ---------------------------------------------------------------------------

describe('candidate display', () => {
  it('caps a same-title list at 10 and summarizes the rest', () => {
    const sessions = Array.from({ length: 15 }, (_, index) =>
      titled(`s${index}`, 'jev浏览器', { updatedAt: 1_700_000_000_000 + index }),
    )
    const match = matchTargetSession(sessions, 'jev浏览器')
    expect(match.kind).toBe('ambiguous')
    if (match.kind !== 'ambiguous') return
    expect(match.candidates).toHaveLength(CANDIDATE_DISPLAY_LIMIT)
    const block = renderCandidateBlock(match.candidates, { total: match.total })
    const lines = block.split('\n')
    expect(lines[0]).toBe('同名会话较多：按下面的 sessionId 或目录指定')
    expect(lines).toHaveLength(1 + CANDIDATE_DISPLAY_LIMIT + 1)
    expect(block).toContain('…还有 5 个同名会话，可用目录关键词进一步收窄')
    // Existing order (running first, then most recent) is preserved: s14..s5.
    expect(lines[1]).toContain('s14')
    expect(lines[CANDIDATE_DISPLAY_LIMIT]).toContain('s5')
  })

  it('renders name · sessionId · cwd · age on a candidate line', () => {
    expect(
      candidateLine({ sessionId: 'session-9', name: 'jev浏览器', hint: '', cwd: 'I:\\JEV', age: '3 天前' }),
    ).toBe('- jev浏览器 · session-9 · I:\\JEV · 3 天前')
  })

  it('tells two rows with the same title apart', () => {
    const block = renderCandidateBlock([
      { sessionId: 'a', name: 'jev浏览器', hint: '', cwd: 'I:\\one', age: '刚刚' },
      { sessionId: 'b', name: 'jev浏览器', hint: '', cwd: 'I:\\two', age: '2 天前' },
    ])
    const lines = block.split('\n').filter((line) => line.startsWith('- '))
    expect(lines).toHaveLength(2)
    expect(lines[0]).not.toBe(lines[1])
    expect(lines[0]).toContain('a')
    expect(lines[1]).toContain('b')
  })

  it('caps the ambiguity refusal at 10 and keeps the reminder line', () => {
    const sessions = Array.from({ length: 15 }, (_, index) =>
      titled(`s${index}`, '同名', { updatedAt: 1_700_000_000_000 + index }),
    )
    const match = matchTargetSession(sessions, '同名')
    const rejection = checkAskGuards({
      guards: { currentSessionId: SELF, hop: 0 },
      match,
      sessions,
      question: 'q',
    })
    expect(rejection?.code).toBe('target-ambiguous')
    expect(rejection?.candidates).toHaveLength(CANDIDATE_DISPLAY_LIMIT)
    expect(rejection?.message).toContain('有 15 个会话都叫这个名字')
    expect(rejection?.message).toContain('同名会话较多')
    expect(rejection?.message).toContain('…还有 5 个同名会话，可用目录关键词进一步收窄')
  })

  it('returns an empty block when there is nothing to show', () => {
    expect(renderCandidateBlock([])).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Workspace registration (what the sidebar shows) and archived sessions
// ---------------------------------------------------------------------------

/** One workspace registry whose workspaces list exactly `sessionIds`. */
function registryCtx(sessionIds: readonly string[], archived: readonly string[] = []): Record<string, unknown> {
  return {
    workspaceRegistry: {
      list: () => [{ sessionIds: [...sessionIds] }],
      ...(archived.length === 0 ? {} : { archivedSessionIds: new Set(archived) }),
    },
  }
}

describe('workspace-registered sessions', () => {
  it('reads the union of all workspaces, minus archived ids', () => {
    const ctx = {
      workspaceRegistry: {
        list: () => [
          { sessionIds: ['a', 'b'] },
          { sessionIds: ['b', 'c'] },
          { sessionIds: undefined },
          null,
        ],
        archivedSessionIds: new Set(['b']),
      },
    }
    expect([...(registeredSessionIds(ctx) ?? [])].sort()).toEqual(['a', 'c'])
  })

  it('returns undefined when the registry is missing, unusable or throwing', () => {
    expect(registeredSessionIds({})).toBeUndefined()
    expect(registeredSessionIds(undefined)).toBeUndefined()
    expect(registeredSessionIds({ workspaceRegistry: {} })).toBeUndefined()
    expect(registeredSessionIds({ workspaceRegistry: { list: 'nope' } })).toBeUndefined()
    expect(
      registeredSessionIds({
        get workspaceRegistry(): never {
          throw new Error('no inject')
        },
      }),
    ).toBeUndefined()
    // An existing registry with no sessions is an EMPTY set, not undefined.
    expect(registeredSessionIds({ workspaceRegistry: { list: () => [] } })).toEqual(new Set())
  })

  it('resolves the registry from the direct property, reflect.get, or ctx.get', () => {
    const direct = { workspaceRegistry: { list: () => [{ sessionIds: ['direct'] }] } }
    expect([...(registeredSessionIds(direct) ?? [])]).toEqual(['direct'])

    const strictCalls: boolean[] = []
    const viaReflect = {
      reflect: {
        get: (name: string, strict: boolean) => {
          strictCalls.push(strict)
          return name === 'workspaceRegistry' ? { list: () => [{ sessionIds: ['reflect'] }] } : undefined
        },
      },
    }
    expect([...(registeredSessionIds(viaReflect) ?? [])]).toEqual(['reflect'])
    // Both the registered and the archived resolution go through the same probe,
    // so the reflection is consulted once per resolution — every call must be non-strict.
    expect(strictCalls.length).toBeGreaterThan(0)
    expect(strictCalls.every((strict) => strict === false)).toBe(true)

    const viaGet = {
      get: (name: string) =>
        name === 'workspaceRegistry' ? { list: () => [{ sessionIds: ['get'] }] } : undefined,
    }
    expect([...(registeredSessionIds(viaGet) ?? [])]).toEqual(['get'])
  })

  it('falls through a throwing path, and every miss returns undefined', () => {
    const throwingDirect = {
      get workspaceRegistry(): never {
        throw new Error('inject')
      },
      reflect: { get: () => ({ list: () => [{ sessionIds: ['fallback'] }] }) },
    }
    expect([...(registeredSessionIds(throwingDirect) ?? [])]).toEqual(['fallback'])

    expect(registeredSessionIds({})).toBeUndefined()
    expect(registeredSessionIds({ reflect: { get: () => undefined }, get: () => undefined })).toBeUndefined()
  })

  it('resolves archived ids through the same paths, and subtracts them', () => {
    const ctx = {
      reflect: { get: () => ({ archivedSessionIds: new Set(['z']), list: () => [{ sessionIds: ['a', 'z'] }] }) },
    }
    expect([...archivedSessionIds(ctx)]).toEqual(['z'])
    expect([...(registeredSessionIds(ctx) ?? [])]).toEqual(['a'])
  })

  it('logs the registry probe once per process', () => {
    resetRegistryProbe()
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
      lines.push(String(message))
    })
    try {
      registeredSessionIds({ workspaceRegistry: { list: () => [{ sessionIds: ['a', 'b'] }] } })
      registeredSessionIds({})
      expect(lines).toEqual([
        '[dsh-advisor-group] workspaceRegistry: ok (1 个工区, 2 个已登记会话)',
      ])
      resetRegistryProbe()
      registeredSessionIds({})
      expect(lines[1]).toBe('[dsh-advisor-group] workspaceRegistry: unavailable — 已退回不过滤')
    } finally {
      spy.mockRestore()
      resetRegistryProbe()
    }
  })

  it('never offers an unregistered session as a target-not-found candidate', async () => {
    const world = fakeWorld({ items: [titled(TARGET, '构建会话'), titled('session-open', '正常会话')] })
    const { ctx, signal, input } = askInput(world, { target: '不存在的会话名' })
    const value = (await askSession(
      { ...(ctx as Record<string, unknown>), ...registryCtx(['session-open']) },
      signal,
      input,
    )) as Record<string, unknown>
    expect(value.error).toBe('target-not-found')
    const candidates = value.candidates as Array<{ sessionId: string }>
    expect(candidates.map((candidate) => candidate.sessionId)).not.toContain(TARGET)
    expect(candidates.map((candidate) => candidate.sessionId)).toContain('session-open')
  })

  it('refuses an explicitly named unregistered session without delivering', async () => {
    const world = fakeWorld({ items: [titled(TARGET, '构建会话')] })
    const { ctx, signal, input } = askInput(world)
    const value = (await askSession(
      { ...(ctx as Record<string, unknown>), ...registryCtx([]) },
      signal,
      input,
    )) as Record<string, unknown>
    expect(value).toMatchObject({
      ok: false,
      error: 'session-unregistered',
      message: UNREGISTERED_SESSION_MESSAGE,
    })
    expect(world.followup).not.toHaveBeenCalled()
    expect(world.prompt).not.toHaveBeenCalled()
  })

  it('keeps the archived refusal message distinct from the unregistered one', async () => {
    const world = fakeWorld({ items: [titled(TARGET, '构建会话')] })
    const { ctx, signal, input } = askInput(world)
    const value = (await askSession(
      { ...(ctx as Record<string, unknown>), ...registryCtx([TARGET], [TARGET]) },
      signal,
      input,
    )) as Record<string, unknown>
    expect(value).toMatchObject({ ok: false, error: 'session-archived', message: ARCHIVED_SESSION_MESSAGE })
    expect(String(value.message)).not.toBe(UNREGISTERED_SESSION_MESSAGE)
    expect(world.followup).not.toHaveBeenCalled()
  })

  it('does not filter when the host has no workspace registry', async () => {
    const world = fakeWorld({ items: [titled(TARGET, '构建会话')] })
    const { ctx, signal, input } = askInput(world, { target: '构建会话', waitMs: 20 })
    const value = (await askSession(ctx, signal, input)) as Record<string, unknown>
    expect(value.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Provisional body for a still-waiting detached ask (display only)
// ---------------------------------------------------------------------------

const FROM_MS = 1_700_000_000_500

function waitingRecord(extra: Partial<AskRecord> = {}): AskRecord {
  return {
    askId: 'ask-waiting',
    sessionId: SELF,
    targetSessionId: TARGET,
    targetName: '目标会话',
    question: '那个报错改了吗？',
    state: 'waiting',
    createdAt: FROM_MS - 1000,
    from: new Date(FROM_MS).toISOString(),
    ...extra,
  }
}

function probeController(events: readonly CrossSessionLogEvent[]): CrossSessionController {
  return {
    list: async () => ({ items: [] }),
    resolveAgent: async () => ({
      agent: {
        session: { id: TARGET, header: { cwd: 'C:\\work' }, snapshotEvents: () => events },
        followup: vi.fn(),
      },
    }),
    prompt: vi.fn(),
  } as unknown as CrossSessionController
}

describe('provisional body for a waiting record', () => {
  it('probes body text produced after delivery', async () => {
    const controller = probeController([
      textEvent(1, FROM_MS - 1000, '投递前的旧答案'),
      textEvent(2, FROM_MS + 5000, '目标已经写出的正文'),
    ])
    expect(await probeWaitingBody(controller, waitingRecord())).toBe('目标已经写出的正文')
  })

  it('returns undefined when nothing was written after delivery', async () => {
    const onlyOld = probeController([textEvent(1, FROM_MS - 1000, '投递前的旧答案')])
    expect(await probeWaitingBody(onlyOld, waitingRecord())).toBeUndefined()
    expect(await probeWaitingBody(probeController([]), waitingRecord())).toBeUndefined()
  })

  it('silently falls back when the target cannot be read', async () => {
    const controller = {
      list: async () => ({ items: [] }),
      resolveAgent: async () => {
        throw new Error('host down')
      },
      prompt: vi.fn(),
    } as unknown as CrossSessionController
    await expect(probeWaitingBody(controller, waitingRecord())).resolves.toBeUndefined()
    expect(deliveryWatermark([textEvent(1, FROM_MS - 1, 'x')], Number.NaN)).toBe(-1)
  })

  it('labels the provisional body without changing the waiting state', () => {
    const out = renderAskRecords([{ ...waitingRecord(), provisional: '目标已经写出的正文' }])
    expect(out).toContain('- [等待中] 目标会话 · askId=ask-waiting')
    expect(out).toContain('（尚未落定：目标可能仍在继续，下面是目前已收到的正文）')
    expect(out).toContain('目标已经写出的正文')
  })

  it('keeps the old output when there is no provisional body', () => {
    expect(renderAskRecords([waitingRecord()])).toBe(
      ['- [等待中] 目标会话 · askId=ask-waiting', '  问题：那个报错改了吗？'].join('\n'),
    )
    expect(provisionalBodySection('   ')).toBeUndefined()
  })

  it('truncates a long body at the display limit with a note', () => {
    const long = 'x'.repeat(2500)
    const section = provisionalBodySection(long)
    expect(section).toContain(`${'x'.repeat(PROVISIONAL_BODY_LIMIT)}\n…（正文过长，仅显示前 2000 字）`)
    expect(renderAskRecords([{ ...waitingRecord(), provisional: long }]).length).toBeLessThan(2500)
  })
})

describe('detached ask records the parent ask', () => {
  let home: string
  let savedHome: string | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'advisor-group-ask-parent-'))
    savedHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
  })

  afterEach(() => {
    cancelDetachedAsks()
    resetPendingWaits()
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    rmSync(home, { recursive: true, force: true })
  })

  async function detachAndRead(currentEvents: readonly CrossSessionLogEvent[]) {
    const world = fakeWorld({ items: [titled(TARGET, '目标会话')], targetEvents: [] })
    const value = (await askSession({ sessionController: world.controller }, new AbortController().signal, {
      currentSessionId: SELF,
      senderName: '提问方',
      currentEvents,
      target: TARGET,
      question: '接着问一下',
      detach: true,
    })) as Record<string, unknown>
    expect(value.ok).toBe(true)
    const dir = askStoreDir(join(home, 'storages', 'advisor-group'))
    return readAskRecord(dir, String(value.askId))
  }

  it('stores the inbound askId as parentAskId', async () => {
    const record = await detachAndRead([userEvent(1, 1, askSource(1))])
    expect(record?.parentAskId).toBe('a1')
  })

  it('stores no parentAskId for a normal user-initiated ask', async () => {
    const record = await detachAndRead([userEvent(1, 1, { kind: 'user' })])
    expect(record).toBeDefined()
    expect(record?.parentAskId).toBeUndefined()
  })

  it('stamps the wait with this host process and the delivery watermark', async () => {
    const record = await detachAndRead([])
    expect(record?.bootId).toBe(ASK_BOOT_ID)
    expect(typeof record?.fromSeq).toBe('number')
  })
})

// ---------------------------------------------------------------------------
// Answer copy-back into the asking session
// ---------------------------------------------------------------------------

describe('answer copy-back', () => {
  let home: string
  let savedHome: string | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'advisor-group-copyback-'))
    savedHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
  })

  afterEach(() => {
    cancelDetachedAsks()
    resetPendingWaits()
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    rmSync(home, { recursive: true, force: true })
  })

  function copyBackDir(): string {
    return askStoreDir(join(home, 'storages', 'advisor-group'))
  }

  interface DetachedRecord {
    readonly askId: string
    readonly read: () => AskRecord | undefined
  }

  async function detachRecord(world: FakeWorld, overrides: Record<string, unknown> = {}): Promise<DetachedRecord> {
    const value = (await askSession(
      { sessionController: world.controller },
      new AbortController().signal,
      {
        currentSessionId: SELF,
        senderName: '提问方',
        currentEvents: [],
        target: TARGET,
        question: '接着问一下',
        detach: true,
        waitMs: 30,
        ...overrides,
      },
    )) as Record<string, unknown>
    expect(value.ok).toBe(true)
    const askId = String(value.askId)
    return { askId, read: () => readAskRecord(copyBackDir(), askId) }
  }

  it('copies a settled answer back once and marks the record', async () => {
    const world = fakeWorld({
      items: [titled(TARGET, '目标会话')],
      watermarkEvents: () => [textEvent(1, 1000, '旧的正文')],
      targetEvents: [textEvent(2, 2000, '答复正文')],
    })
    const { askId, read } = await detachRecord(world)
    await until(() => read()?.state === 'done' && read()?.deliveredBack === true)
    expect(read()?.state).toBe('done')
    expect(read()?.deliveredBack).toBe(true)
    // A second settle (or a second read) must never send it again.
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(world.prompt).toHaveBeenCalledTimes(1)
    const sent = world.prompt.mock.calls[0][0] as {
      sessionId: string
      requestId: string
      content: readonly { text: string }[]
    }
    expect(sent.sessionId).toBe(SELF)
    expect(sent.requestId).toBe(`${askId}-answer`)
    expect(sent.content[0].text).toBe(`【来自「目标会话」 · askId=${askId}】\n答复正文`)
  })

  it('settles the card and sends only a pointer when a card exists', async () => {
    const world = fakeWorld({
      items: [titled(TARGET, '目标会话')],
      watermarkEvents: () => [textEvent(1, 1000, '旧的正文')],
      targetEvents: [textEvent(2, 2000, '答复正文')],
    })
    const settled: AskCardSettle[] = []
    const { askId, read } = await detachRecord(world, {
      onSettled: (info: AskCardSettle) => settled.push(info),
    })
    await until(() => read()?.state === 'done' && read()?.deliveredBack === true)
    expect(settled).toHaveLength(1)
    expect(settled[0].askId).toBe(askId)
    expect(settled[0].targetName).toBe('目标会话')
    expect(settled[0].answer).toBe('答复正文')
    expect(settled[0].note).toContain('等待结束')
    const sent = world.prompt.mock.calls[0][0] as { content: readonly { text: string }[] }
    expect(sent.content[0].text).toContain(`askId=${askId}`)
    expect(sent.content[0].text).toContain('ask_result')
    // The card already holds the full text; the message must not repeat it.
    expect(sent.content[0].text).not.toContain('答复正文')
  })

  it('settles the card on timeout as well', async () => {
    const busy = titled(TARGET, '目标会话', { running: true })
    const world = fakeWorld({ items: [busy], listItems: () => [busy] })
    const settled: AskCardSettle[] = []
    const { read } = await detachRecord(world, {
      onSettled: (info: AskCardSettle) => settled.push(info),
    })
    await until(() => read()?.state === 'timeout' && settled.length > 0)
    expect(settled[0].answer).toBe('')
    expect(settled[0].note).toContain('上限')
  })

  it('does not copy back a timeout', async () => {
    const busy = titled(TARGET, '目标会话', { running: true })
    const world = fakeWorld({ items: [busy], listItems: () => [busy] })
    const { read } = await detachRecord(world)
    await until(() => read()?.state === 'timeout')
    expect(read()?.state).toBe('timeout')
    expect(read()?.deliveredBack).toBeUndefined()
    expect(world.prompt).not.toHaveBeenCalled()
  })

  it('does not copy back an error', async () => {
    let listCalls = 0
    const world = fakeWorld({
      items: [titled(TARGET, '目标会话')],
      listItems: () => {
        listCalls += 1
        if (listCalls > 1) throw new Error('list boom')
        return [titled(TARGET, '目标会话')]
      },
    })
    const { read } = await detachRecord(world)
    await until(() => read()?.state === 'error')
    expect(read()?.state).toBe('error')
    expect(read()?.deliveredBack).toBeUndefined()
    expect(world.prompt).not.toHaveBeenCalled()
  })

  it('keeps the answer readable and adds a note when the copy-back fails', async () => {
    const world = fakeWorld({
      items: [titled(TARGET, '目标会话')],
      watermarkEvents: () => [textEvent(1, 1000, '旧的正文')],
      targetEvents: [textEvent(2, 2000, '答复正文')],
    })
    world.prompt.mockRejectedValue(new Error('inbox full'))
    const { read } = await detachRecord(world)
    await until(() => read()?.deliverBackNote !== undefined)
    const record = read()
    expect(record?.state).toBe('done')
    expect(record?.answer).toBe('答复正文')
    expect(record?.deliveredBack).toBeUndefined()
    expect(String(record?.deliverBackNote)).toContain('自动回送失败')
    expect(String(record?.deliverBackNote)).toContain('ask_result')
  })

  it('sends a very long answer in full, without truncation', async () => {
    const long = 'x'.repeat(50_000)
    const world = fakeWorld({
      items: [titled(TARGET, '目标会话')],
      watermarkEvents: () => [textEvent(1, 1000, '旧的正文')],
      targetEvents: [textEvent(2, 2000, long)],
    })
    const { askId, read } = await detachRecord(world)
    await until(() => read()?.state === 'done' && read()?.deliveredBack === true)
    expect(world.prompt).toHaveBeenCalledTimes(1)
    const sent = world.prompt.mock.calls[0][0] as { content: readonly { text: string }[] }
    expect(sent.content[0].text).toContain(long)
    expect(sent.content[0].text.startsWith(`【来自「目标会话」 · askId=${askId}】\n`)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Guard set
// ---------------------------------------------------------------------------

describe('ask guards', () => {
  const uniqueTarget = { kind: 'unique' as const, target: { sessionId: TARGET, name: '构建会话' } }

  it('refuses a session asking itself', () => {
    const rejection = checkAskGuards({
      guards: { currentSessionId: TARGET, hop: 0 },
      match: { kind: 'unique', target: { sessionId: TARGET, name: 'me' } },
      sessions: [],
      question: 'q',
    })
    expect(rejection?.code).toBe('self-target')
  })

  it('refuses a subagent session and points at the subagent channel', () => {
    const rejection = checkAskGuards({
      guards: { currentSessionId: SELF, hop: 0 },
      match: uniqueTarget,
      sessions: [summary({ sessionId: TARGET, origin: 'subagent' })],
      question: 'q',
    })
    expect(rejection?.code).toBe('subagent-target')
    expect(rejection?.message).toContain('subagent')
  })

  it('surfaces ambiguity as candidates, never as a guess', () => {
    const rejection = checkAskGuards({
      guards: { currentSessionId: SELF, hop: 0 },
      match: { kind: 'ambiguous', candidates: [{ sessionId: 'a', name: '同名', hint: '同名' }] },
      sessions: [],
      question: 'q',
    })
    expect(rejection?.code).toBe('target-ambiguous')
    expect(rejection?.candidates).toHaveLength(1)
  })

  it('reports a missing target and hands back the recent sessions instead of an id hunt', () => {
    const rejection = checkAskGuards({
      guards: { currentSessionId: SELF, hop: 0 },
      match: { kind: 'missing' },
      sessions: [
        titled('s1', '构建会话', { updatedAt: 1700000000000 }),
        titled('s2', '文档会话', { updatedAt: 1700000001000 }),
      ],
      question: 'q',
    })
    expect(rejection?.code).toBe('target-not-found')
    expect(rejection?.candidates?.map((candidate) => candidate.name)).toEqual(['文档会话', '构建会话'])
    expect(rejection?.message).toContain('最近的会话')
  })

  it('refuses a payload over the byte budget', () => {
    const rejection = checkAskGuards({
      guards: { currentSessionId: SELF, hop: 0 },
      match: uniqueTarget,
      sessions: [],
      question: 'a'.repeat(ASK_CONTENT_MAX_BYTES),
      context: 'b',
    })
    expect(rejection?.code).toBe('content-too-large')
    expect(rejection?.message).toContain(String(ASK_CONTENT_MAX_BYTES))
  })
})

// ---------------------------------------------------------------------------
// Interval filtering
// ---------------------------------------------------------------------------

describe('answer interval', () => {
  it('excludes assistant text written before delivery', () => {
    const events = [
      textEvent(1, 1000, '投递前说的'),
      textEvent(2, 2000, '投递后说的'),
      textEvent(3, 3000, '又说了一句'),
    ]
    const collected = collectAnswer(events, 1)
    expect(collected.pieces).toEqual(['投递后说的', '又说了一句'])
    expect(joinAnswerPieces(collected.pieces)).toBe('投递后说的\n\n又说了一句')
  })

  it('excludes events whose sequence predates the watermark even when time is coarse', () => {
    expect(collectAnswer([textEvent(5, 2000, '旧的'), textEvent(6, 2000, '新的')], 5).pieces).toEqual(['新的'])
  })

  it('ignores non-text blocks, empty bodies, and non-assistant events', () => {
    const reasoning: CrossSessionLogEvent = {
      type: 'assistant/message',
      seq: 2,
      time: 2000,
      data: { message: { content: [{ type: 'reasoning', text: '想' } as never] } },
    }
    const blank = textEvent(3, 2000, '   ')
    const tool: CrossSessionLogEvent = {
      type: 'tool/result',
      seq: 4,
      time: 2000,
      data: { message: { content: [] } },
    }
    expect(collectAnswer([reasoning, blank, tool], 1).pieces).toEqual([])
  })

  it('tracks the newest event time and the highest sequence number', () => {
    const events = [textEvent(1, 1000, 'a'), textEvent(4, 4000, 'b')]
    expect(collectAnswer(events, -1).latestEventTime).toBe(4000)
    expect(logWatermark(events)).toBe(4)
    expect(logWatermark([])).toBe(-1)
  })
})

// ---------------------------------------------------------------------------
// Wait budget + rendering
// ---------------------------------------------------------------------------

describe('wait budget and rendering', () => {
  // Regression: a turn that starts and finishes between two polls never shows
  // `running`, so polling alone would spin to the timeout while the answer sits
  // in the log (found in review 2026-10-03, fixed by the delivery-floor check).
  it('settles on the delivery floor when the busy state was never sampled', async () => {
    let watermarkReads = 0
    const world = fakeWorld({
      items: [titled(TARGET, '构建会话')],
      watermarkEvents: () => (watermarkReads++ === 0 ? [] : [textEvent(1, Date.now(), '已经改好了')]),
      targetEvents: [textEvent(1, Date.now(), '已经改好了')],
      listItems: () => [titled(TARGET, '构建会话')], // never reports running
    })
    const started = Date.now()
    const outcome = await waitForTargetIdle(world.controller, new AbortController().signal, {
      sessionId: TARGET,
      targetWasRunning: false,
      waitMs: 30000,
      log: () => {},
      fromSeq: 0,
    })
    expect(outcome.endedBecause).toBe('idle')
    expect(Date.now() - started).toBeLessThan(10000) // must not spin to the 30s timeout
    expect(world.cancel).not.toHaveBeenCalled()
  })
  it('defaults, clamps to the ceiling, and rejects nonsense', () => {
    expect(normalizeWaitMs(undefined)).toBe(ASK_WAIT_DEFAULT_MS)
    expect(normalizeWaitMs(0)).toBe(ASK_WAIT_DEFAULT_MS)
    expect(normalizeWaitMs(-5)).toBe(ASK_WAIT_DEFAULT_MS)
    expect(normalizeWaitMs(Number.NaN)).toBe(ASK_WAIT_DEFAULT_MS)
    expect(normalizeWaitMs(1234.9)).toBe(1234)
    expect(normalizeWaitMs(ASK_WAIT_MAX_MS * 10)).toBe(ASK_WAIT_MAX_MS)
    expect(ASK_WAIT_DEFAULT_MS).toBe(180000)
    expect(ASK_WAIT_MAX_MS).toBe(600000)
  })

  it('renders the interval answer plus the note for the main model', () => {
    const blocks = renderAskResult({ answer: '改好了', note: '区间说明' })
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toEqual({ type: 'text', text: '改好了\n\n区间说明' })
  })

  it('says so explicitly when the target produced no text', () => {
    const blocks = renderAskResult({ answer: '', note: '区间说明' })
    expect(blocks[0].type === 'text' && blocks[0].text).toContain('没有产出正文')
  })
})

// ---------------------------------------------------------------------------
// Host error recognition
// ---------------------------------------------------------------------------

describe('host error recognition', () => {
  it('recognises the subagent delivery rejection', () => {
    expect(
      isSubagentDeliveryRejection({
        code: 'session/agent-busy',
        message: 'session "x" is owned by subagent routing',
        details: { reason: 'use subagent delivery for this child session' },
      }),
    ).toBe(true)
    expect(isSubagentDeliveryRejection({ code: 'session/not-found' })).toBe(false)
    expect(isSubagentDeliveryRejection(undefined)).toBe(false)
  })

  it('takes the host service lazily and tolerates an old host', () => {
    expect(getSessionController(undefined)).toBeUndefined()
    expect(getSessionController({})).toBeUndefined()
    expect(getSessionController({ sessionController: { list: () => {} } })).toBeUndefined()
    const world = fakeWorld({ items: [] })
    expect(getSessionController({ sessionController: world.controller })).toBe(world.controller)
  })

  // Regression (2026-10-03, first live run): a bare `ctx.sessionController` read on a
  // host Context whose plugin does not inject that key throws
  // `cannot get property "sessionController" without inject` — the property read itself
  // fails, so null checks around it never run. `ctx.get(name)` is the documented read
  // without the inject requirement; this proxy throws on every other key, so the test
  // fails again if the gated property is ever touched directly.
  it('reads through ctx.get when the host gates the property behind inject', () => {
    const world = fakeWorld({ items: [] })
    const gated = new Proxy(
      { read: (name: string) => (name === 'sessionController' ? world.controller : undefined) },
      {
        get(target, key) {
          if (key === 'get') return target.read
          throw new Error(`cannot get property "${String(key)}" without inject`)
        },
      },
    )
    expect(getSessionController(gated)).toBe(world.controller)
    // Host that has no such service → degrade to undefined, not a throw.
    expect(getSessionController({ get: () => undefined })).toBeUndefined()
    // A throwing reader is still contained.
    expect(
      getSessionController({
        get: () => {
          throw new Error('boom')
        },
      }),
    ).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

describe('ask_session orchestration', () => {
  it('delivers natively, waits for idle, and reports what the target said', async () => {
    resetPendingWaits()
    // Only the pre-delivery event is in the log when the question is handed
    // over; the second one stands for text the target appends afterwards.
    const preDelivery = textEvent(1, 1000, '投递前就说过的话')
    const postDelivery = textEvent(2, Date.now() + 60000, '改好了，是第二步的类型错了')
    const runningTarget = titled(TARGET, '构建会话', { running: true })
    const world = fakeWorld({
      items: [runningTarget, summary({ sessionId: SELF })],
      targetEvents: [preDelivery, postDelivery],
      watermarkEvents: () => [preDelivery],
      listItems: idleAfterTurn(runningTarget),
    })
    const { ctx, signal, input } = askInput(world)
    const value = (await askSession(ctx, signal, input)) as Record<string, unknown>

    expect(value.ok).toBe(true)
    expect(value.delivered).toBe('native')
    expect(value.target).toEqual({ sessionId: TARGET, name: '构建会话' })
    expect(typeof value.askId).toBe('string')
    expect((value.interval as { endedBecause: string }).endedBecause).toBe('idle')
    expect((value.interval as { to: unknown }).to).toEqual(expect.any(String))
    expect(value.answer).toBe('改好了，是第二步的类型错了')
    expect(String(value.note)).toContain('区间语义')
    expect(String(value.note)).toContain('整体空闲')
    expect(String(value.note)).toContain('投递时对方正在忙')
    expect(world.followup).toHaveBeenCalledTimes(1)
    expect(world.prompt).not.toHaveBeenCalled()
    expect(world.cancel).not.toHaveBeenCalled()
    // The delivered message really is ours, with the envelope and our source.
    const delivered = world.followup.mock.calls[0][0] as {
      source: SessionAskMessageSource
      content: readonly { readonly type: string; readonly text?: string }[]
    }
    expect(delivered.source.kind).toBe('session-ask')
    expect(delivered.source.hop).toBe(0)
    expect(delivered.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('【来自会话「提问方」的提问') })
  })

  it('times out on a still-busy target, returns what it has, and never cancels it', async () => {
    resetPendingWaits()
    const busy = titled(TARGET, '构建会话', { running: true })
    const world = fakeWorld({
      items: [busy],
      listItems: () => [busy],
      // One pre-delivery message and one appended by the target after handover:
      // only the second may be reported, even though the wait times out.
      targetEvents: [
        textEvent(9, 1000, '投递前就说过的话'),
        textEvent(10, Date.now() + 60000, '还在做，先给你一句'),
      ],
      watermarkEvents: () => [textEvent(9, 1000, '投递前就说过的话')],
    })
    const { ctx, signal, input } = askInput(world, { waitMs: 20 })
    const value = (await askSession(ctx, signal, input)) as Record<string, unknown>

    expect(value.ok).toBe(true)
    expect((value.interval as { endedBecause: string }).endedBecause).toBe('timeout')
    expect((value.interval as { to: unknown }).to).toBeNull()
    expect(value.answer).toBe('还在做，先给你一句')
    expect(String(value.note)).toContain('没有取消对方的回合')
    expect(world.cancel).not.toHaveBeenCalled()
  })

  it('reports an empty interval answer when the target said nothing after delivery', async () => {
    resetPendingWaits()
    const busy = titled(TARGET, '构建会话', { running: true })
    const world = fakeWorld({
      items: [busy],
      listItems: () => [busy],
      targetEvents: [textEvent(9, 1000, '投递前就说过的话')],
    })
    const { ctx, signal, input } = askInput(world, { waitMs: 20 })
    const value = (await askSession(ctx, signal, input)) as Record<string, unknown>
    expect(value.ok).toBe(true)
    expect(value.answer).toBe('')
    expect((value.interval as { endedBecause: string }).endedBecause).toBe('timeout')
  })

  it('falls back to the host prompt path and says so honestly', async () => {
    resetPendingWaits()
    const world = fakeWorld({ items: [titled(TARGET, '构建会话')] })
    world.resolveAgent.mockResolvedValue({ error: { code: 'session/writer-held' } })
    const { ctx, signal, input } = askInput(world)
    const value = (await askSession(ctx, signal, input)) as Record<string, unknown>

    expect(value.ok).toBe(true)
    expect(value.delivered).toBe('fallback')
    expect(String(value.note)).toContain('降级通道')
    expect(String(value.note)).toContain('用户输入')
    expect(world.followup).not.toHaveBeenCalled()
    expect(world.prompt).toHaveBeenCalledTimes(1)
    const delivered = world.prompt.mock.calls[0][0] as {
      mode: string
      sessionId: string
      requestId: string
      content: readonly { readonly text?: string }[]
    }
    expect(delivered.mode).toBe('queue')
    expect(delivered.sessionId).toBe(TARGET)
    expect(delivered.requestId).toBe(value.askId)
    expect(String(delivered.content[0].text)).toContain('【来自会话「提问方」的提问')
  })

  it('returns subagent-target when the host rejects subagent delivery', async () => {
    resetPendingWaits()
    const world = fakeWorld({ items: [titled(TARGET, '子会话')] })
    world.resolveAgent.mockResolvedValue({
      error: {
        code: 'session/agent-busy',
        message: 'owned by subagent routing',
        details: { reason: 'use subagent delivery for this child session' },
      },
    })
    const { ctx, signal, input } = askInput(world)
    const value = (await askSession(ctx, signal, input)) as Record<string, unknown>
    expect(value.ok).toBe(false)
    expect(value.error).toBe('subagent-target')
    expect(world.prompt).not.toHaveBeenCalled()
  })

  it('refuses a second concurrent wait in the same session', async () => {
    resetPendingWaits()
    const busy = titled(TARGET, '构建会话', { running: true })
    const world = fakeWorld({ items: [busy], listItems: () => [busy] })
    const ctx = { sessionController: world.controller }
    const signal = new AbortController().signal
    const base = {
      currentSessionId: SELF,
      senderName: '提问方',
      currentEvents: [] as readonly CrossSessionLogEvent[],
      target: TARGET,
      waitMs: 40,
    }
    // Started without awaiting so it is provably still waiting when the second
    // call arrives; `askSession` latches the wait synchronously.
    const first = askSession(ctx, signal, { ...base, question: '第一个问题' })
    const second = (await askSession(ctx, signal, { ...base, question: '第二个问题' })) as Record<string, unknown>
    expect(second.ok).toBe(false)
    expect(second.error).toBe('already-waiting')
    const settled = (await first) as Record<string, unknown>
    expect(settled.ok).toBe(true)
    resetPendingWaits()
  })

  it('reports service-missing on a host without sessionController', async () => {
    resetPendingWaits()
    const value = (await askSession({}, new AbortController().signal, {
      currentSessionId: SELF,
      senderName: '提问方',
      currentEvents: [],
      target: TARGET,
      question: 'q',
    })) as Record<string, unknown>
    expect(value.ok).toBe(false)
    expect(value.error).toBe('service-missing')
  })

  it('reports target-ambiguous with candidates', async () => {
    resetPendingWaits()
    const world = fakeWorld({ items: [titled('a', '同名'), titled('b', '同名')] })
    const { ctx, signal, input } = askInput(world, { target: '同名' })
    const value = (await askSession(ctx, signal, input)) as Record<string, unknown>
    expect(value.ok).toBe(false)
    expect(value.error).toBe('target-ambiguous')
    expect((value.candidates as readonly unknown[]).length).toBe(2)
    expect(world.followup).not.toHaveBeenCalled()
  })

  it('propagates the inbound hop into the delivered source', async () => {
    resetPendingWaits()
    const runningTarget = titled(TARGET, '构建会话', { running: true })
    const world = fakeWorld({
      items: [runningTarget],
      listItems: idleAfterTurn(runningTarget),
      targetEvents: [textEvent(1, Date.now() + 60000, '收到')],
    })
    const { ctx, signal, input } = askInput(world, { currentEvents: [userEvent(1, 1, askSource(1))] })
    const value = (await askSession(ctx, signal, input)) as Record<string, unknown>
    expect(value.ok).toBe(true)
    expect((world.followup.mock.calls[0][0] as { source: SessionAskMessageSource }).source.hop).toBe(2)
  })

  it('refuses a third hop before delivering anything', async () => {
    resetPendingWaits()
    const world = fakeWorld({ items: [titled(TARGET, '构建会话')] })
    const { ctx, signal, input } = askInput(world, { currentEvents: [userEvent(1, 1, askSource(2))] })
    const value = (await askSession(ctx, signal, input)) as Record<string, unknown>
    expect(value.ok).toBe(false)
    expect(value.error).toBe('hop-limit')
    expect(world.followup).not.toHaveBeenCalled()
  })

  it('refuses an oversized payload before delivering anything', async () => {
    resetPendingWaits()
    const world = fakeWorld({ items: [titled(TARGET, '构建会话')] })
    const { ctx, signal, input } = askInput(world, { question: 'a'.repeat(ASK_CONTENT_MAX_BYTES + 1) })
    const value = (await askSession(ctx, signal, input)) as Record<string, unknown>
    expect(value.ok).toBe(false)
    expect(value.error).toBe('content-too-large')
    expect(world.followup).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Cross-session card hooks (open on delivery, settle with the answer)
// ---------------------------------------------------------------------------

describe('ask card hooks', () => {
  it('opens the card on delivery and closes it with the answer, in order', async () => {
    resetPendingWaits()
    const preDelivery = textEvent(1, 1000, '投递前就说过的话')
    const postDelivery = textEvent(2, Date.now() + 60000, '改好了，是第二步的类型错了')
    const runningTarget = titled(TARGET, '构建会话', { running: true })
    const world = fakeWorld({
      items: [runningTarget, summary({ sessionId: SELF })],
      targetEvents: [preDelivery, postDelivery],
      watermarkEvents: () => [preDelivery],
      listItems: idleAfterTurn(runningTarget),
    })
    const order: string[] = []
    let delivery: AskCardDelivery | undefined
    let settle: AskCardSettle | undefined
    const { ctx, signal, input } = askInput(world, {
      onDelivered: (info: AskCardDelivery) => {
        order.push('delivered')
        delivery = info
      },
      onSettled: (info: AskCardSettle) => {
        order.push('settled')
        settle = info
      },
    })
    const value = (await askSession(ctx, signal, input)) as Record<string, unknown>

    expect(value.ok).toBe(true)
    // The card must open while the wait runs, not only after it ends.
    expect(order).toEqual(['delivered', 'settled'])
    expect(delivery).toBeDefined()
    expect(delivery?.senderName).toBe('提问方')
    expect(delivery?.targetName).toBe('构建会话')
    expect(delivery?.question).toBeTruthy()
    expect(typeof delivery?.askId).toBe('string')
    expect(settle).toBeDefined()
    expect(settle?.askId).toBe(delivery?.askId)
    expect(settle?.targetName).toBe('构建会话')
    expect(settle?.answer).toBe('改好了，是第二步的类型错了')
    expect(settle?.note).toContain('区间语义')
  })

  it('never opens the card when a guard rejects before delivery', async () => {
    resetPendingWaits()
    const world = fakeWorld({ items: [summary({ sessionId: SELF })] })
    const onDelivered = vi.fn()
    const onSettled = vi.fn()
    const { ctx, signal, input } = askInput(world, {
      target: '不存在的会话',
      onDelivered,
      onSettled,
    })
    const value = (await askSession(ctx, signal, input)) as Record<string, unknown>
    expect(value.ok).toBe(false)
    expect(onDelivered).not.toHaveBeenCalled()
    expect(onSettled).not.toHaveBeenCalled()
  })

  it('settles the already-open card when the wait ends in error (cancelled mid-flight)', async () => {
    resetPendingWaits()
    const busy = titled(TARGET, '构建会话', { running: true })
    const world = fakeWorld({ items: [busy], listItems: () => [busy] })
    const onDelivered = vi.fn()
    const onSettled = vi.fn<(info: AskCardSettle) => void>()
    const { ctx, input } = askInput(world, { waitMs: 60_000, onDelivered, onSettled })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 30)

    const value = (await askSession(ctx, controller.signal, input)) as Record<string, unknown>
    // A cancelled wait is an honest outcome, not a throw: delivery happened,
    // so the card exists and MUST be closed instead of stuck in waiting.
    expect(value.ok).toBe(true)
    expect((value.interval as { endedBecause: string }).endedBecause).toBe('error')
    expect(onDelivered).toHaveBeenCalledTimes(1)
    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(onSettled.mock.calls[0]?.[0].note).toContain('调用被取消')
  })
})

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

describe('ask_session tool contract', () => {
  const tools = registerAdvisorTools({} as AdvisorGroupService, {
    sessionController: fakeWorld({ items: [] }).controller,
  })
  const tool = tools.find((candidate) => candidate.name === 'ask_session')

  it('is registered alongside the existing advisor tools', () => {
    expect(tool).toBeDefined()
    expect(tools.map((candidate) => candidate.name)).toEqual([
      'ask_advisors',
      'toggle_advisor_group',
      'ask_session',
      'ask_sessions',
      'list_sessions',
      'ask_result',
    ])
  })

  it('requires target and question, and never claims the reply is a one-to-one answer', () => {
    const params = tool?.parameters as Record<string, { description?: string; required?: boolean }>
    expect(params.target?.required).toBeFalsy()
    expect(params.question?.required).toBe(true)
    const description = String(tool?.description ?? '')
    expect(description).toContain('NOT a one-to-one reply')
    expect(description).toContain('never guess')
    expect(description.toLowerCase()).toContain('subagent')
  })

  it('declares the documented result shape', () => {
    const schema = (tool?.output as { schema: { properties: Record<string, unknown> } }).schema
    expect(Object.keys(schema.properties).sort()).toEqual([
      'answer',
      'askId',
      'candidates',
      'delivered',
      'detached',
      'error',
      'interval',
      'message',
      'note',
      'ok',
      'reply',
      'routeCandidates',
      'status',
      'target',
    ])
  })

  it('returns a structured error instead of throwing when the host lacks the service', async () => {
    // The swarm guard reads the plugin config first; this host is only missing
    // the sessionController, so the stub still answers getConfig().
    const noController = {
      getConfig: () => ({ swarm: { enabled: true } }),
    } as unknown as AdvisorGroupService
    const bare = registerAdvisorTools(noController).find(
      (candidate) => candidate.name === 'ask_session',
    )
    const execute = bare?.execute as (args: unknown, exec: unknown) => Promise<Record<string, unknown>>
    const value = await execute({ target: TARGET, question: 'q' }, { signal: new AbortController().signal })
    expect(value).toMatchObject({ ok: false, error: 'service-missing', answer: '', note: '' })
    expect((value.interval as { endedBecause: string }).endedBecause).toBe('error')
  })
})

// ---------------------------------------------------------------------------
// Structured reply protocol (结论 / 依据 / 不确定)
// ---------------------------------------------------------------------------

describe('structured reply protocol', () => {
  it('delivers the sender, the question and the background, nothing else', () => {
    const texts = buildAskEnvelope('甲会话', '问题正文', '一点背景').map(
      (block) => String((block as unknown as { readonly text: string }).text),
    )
    expect(texts).toEqual([
      '【来自会话「甲会话」的提问】',
      '问题正文',
      '【对方补充的背景】\n一点背景',
    ])
  })

  it('parses the three fields, tolerating markdown bullets and bold markers', () => {
    expect(parseAskReply('**结论**：版本是 0.2.2\n- 依据：四处一致\n不确定：无')).toEqual({
      conclusion: '版本是 0.2.2',
      basis: '四处一致',
      uncertainty: '无',
    })
  })

  it('returns undefined for prose that ignores the convention', () => {
    expect(parseAskReply('它回了一大段话，没有分行，也没有那三个词。')).toBeUndefined()
  })

  it('takes the first value per field and skips empty ones', () => {
    expect(parseAskReply('结论：A\n结论：B\n依据：\n不确定：C')).toEqual({
      conclusion: 'A',
      uncertainty: 'C',
    })
  })

  it('states how much of an answer can be trusted', () => {
    expect(askStatus({ endedBecause: 'idle', answer: '一大段自然的话' })).toBe('ok')
    expect(askStatus({ endedBecause: 'timeout', answer: '一大段自然的话' })).toBe('partial')
    expect(askStatus({ endedBecause: 'error', answer: '出错了' })).toBe('failed')
    expect(askStatus({ endedBecause: 'idle', answer: '   ' })).toBe('failed')
  })

  it('renders the parsed reply instead of the raw answer when both exist', () => {
    const text = (
      renderAskResult({
        answer: '结论：甲\n依据：乙\n\n一大段原文',
        note: '备注一行',
        reply: { conclusion: '甲', basis: '乙' },
      })[0] as unknown as { readonly text: string }
    ).text
    expect(text).toContain('结论：甲')
    expect(text).toContain('依据：乙')
    expect(text).not.toContain('一大段原文')
    expect(text).toContain('备注一行')
  })

  it('falls back to the raw answer when the target ignored the convention', () => {
    const text = (
      renderAskResult({ answer: '一段自由发挥的话', note: '备注' })[0] as unknown as {
        readonly text: string
      }
    ).text
    expect(text).toContain('一段自由发挥的话')
  })
})

// ---------------------------------------------------------------------------
// Batch ask (ask_sessions)
// ---------------------------------------------------------------------------

interface BatchTargetSpec {
  readonly id: string
  readonly title: string
  readonly origin?: 'subagent'
  /** Reports running forever: the wait hits its ceiling. */
  readonly busy?: boolean
  /** Assistant text before delivery (sets the delivery watermark). */
  readonly before?: string
  /** Assistant text after delivery: what the batch collects. */
  readonly answer?: string
  /** Makes both delivery channels fail. */
  readonly deliverThrows?: unknown
}

/**
 * Minimal multi-target host: every spec is a session whose log shows `before`
 * until a delivery happened and `before + answer` afterwards. `busy` specs stay
 * running so the per-target ceiling has something to hit.
 */
function batchWorld(specs: readonly BatchTargetSpec[], extra: readonly CrossSessionSummary[] = []) {
  const deliveries = new Map<string, number>()
  const followups: Array<{ sessionId: string; source: SessionAskMessageSource }> = []
  const prompts: Array<Record<string, unknown>> = []
  const controller: CrossSessionController = {
    list: async () => ({
      items: [
        ...specs.map((spec) =>
          summary({
            sessionId: spec.id,
            running: spec.busy === true,
            ...(spec.origin === undefined ? {} : { origin: spec.origin }),
            projections: { values: { title: spec.title } },
          }),
        ),
        ...extra,
      ],
    }),
    resolveAgent: async (sessionId: string) => {
      const spec = specs.find((candidate) => candidate.id === sessionId)
      if (spec === undefined) return { error: { code: 'session/not-found' } }
      if (spec.deliverThrows !== undefined) throw spec.deliverThrows
      const delivered = (deliveries.get(sessionId) ?? 0) > 0
      const events: CrossSessionLogEvent[] = [
        ...(spec.before === undefined ? [] : [textEvent(1, 1000, spec.before)]),
        ...(delivered && spec.answer !== undefined ? [textEvent(3, 2000, spec.answer)] : []),
      ]
      return {
        agent: {
          session: { id: sessionId, header: { cwd: 'C:\\work' }, snapshotEvents: () => events },
          followup: (message: unknown) => {
            deliveries.set(sessionId, (deliveries.get(sessionId) ?? 0) + 1)
            followups.push({ sessionId, source: (message as { source: SessionAskMessageSource }).source })
          },
        },
      }
    },
    // The auto copy-back reaches a non-target session (the asker) through the
    // host prompt queue; record it so tests can count merged messages.
    prompt: async (message: unknown) => {
      prompts.push(message as Record<string, unknown>)
      return { accepted: true }
    },
  }
  return { controller, followups, prompts }
}

function batchInput(targets: readonly string[], overrides: Partial<AskSessionsInput> = {}): AskSessionsInput {
  return {
    currentSessionId: SELF,
    currentEvents: [],
    targets,
    question: '大家都看一下这个报错',
    defaultWaitMs: 60,
    swarmEnabled: true,
    log: () => {},
    ...overrides,
  }
}

/** Poll a predicate (background records settle on their own schedule). */
async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('ask_sessions batch', () => {
  let home: string
  let savedHome: string | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'advisor-group-batch-'))
    savedHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    resetPendingWaits()
  })

  afterEach(() => {
    cancelDetachedAsks()
    resetPendingWaits()
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    rmSync(home, { recursive: true, force: true })
  })

  const recordDir = (): string => askStoreDir(join(home, 'storages', 'advisor-group'))

  it('delivers to three targets and returns three results in order', async () => {
    const world = batchWorld([
      { id: 't1', title: '甲会话', answer: '甲的答复' },
      { id: 't2', title: '乙会话', answer: '乙的答复' },
      { id: 't3', title: '丙会话', answer: '丙的答复' },
    ])
    const value = await askSessions(
      { sessionController: world.controller },
      new AbortController().signal,
      batchInput(['t1', 't2', 't3'], { waitMs: 20 }),
    )
    expect(value.ok).toBe(true)
    expect(value.count).toBe(3)
    const results = value.results as unknown as Array<Record<string, unknown>>
    expect(results.map((row) => row.sessionId)).toEqual(['t1', 't2', 't3'])
    expect(results.map((row) => row.state)).toEqual(['done', 'done', 'done'])
    expect(results.map((row) => row.answer)).toEqual(['甲的答复', '乙的答复', '丙的答复'])
    expect(value.skipped).toEqual([])
    // Each delivered target got its own record, readable by ask_result later.
    for (const row of results) {
      const record = readAskRecord(recordDir(), String(row.askId))
      expect(record).toMatchObject({ state: 'done', answer: row.answer })
    }
    expect(listAskRecords(recordDir(), { sessionId: SELF })).toHaveLength(3)
    // The batch never touches the single-ask latch.
    expect(isWaiting(SELF)).toBe(false)
  })

  it('records parentAskId on every delivered batch record', async () => {
    const world = batchWorld([{ id: 't1', title: '甲会话', answer: '甲的答复' }])
    const value = await askSessions(
      { sessionController: world.controller },
      new AbortController().signal,
      batchInput(['t1'], { waitMs: 20, currentEvents: [userEvent(1, 1, askSource(1))] }),
    )
    const results = value.results as unknown as Array<Record<string, unknown>>
    expect(readAskRecord(recordDir(), String(results[0].askId))?.parentAskId).toBe('a1')
  })

  it('merges every done answer into ONE copy-back message', async () => {
    const world = batchWorld([
      { id: 't1', title: '甲会话', answer: '甲的答复' },
      { id: 't2', title: '乙会话', answer: '乙的答复' },
      { id: 't3', title: '丙会话', busy: true },
    ])
    const value = await askSessions(
      { sessionController: world.controller },
      new AbortController().signal,
      // Only t1/t2 are done; t3 times out and must stay out of the copy-back.
      batchInput(['t1', 't2', 't3'], { waitMs: 20 }),
    )
    const results = value.results as unknown as Array<Record<string, unknown>>
    expect(results.map((row) => row.state)).toEqual(['done', 'done', 'timeout'])
    expect(world.prompts).toHaveLength(1)
    const sent = world.prompts[0] as {
      sessionId: string
      content: readonly { text: string }[]
    }
    expect(sent.sessionId).toBe(SELF)
    const text = sent.content[0].text
    expect(text).toContain('甲的答复')
    expect(text).toContain('乙的答复')
    expect(text).not.toContain('丙会话')
    // One merged header, not one message per target.
    expect(text.match(/【批量回送/u)).toHaveLength(1)
    for (const row of results.filter((candidate) => candidate.state === 'done')) {
      expect(readAskRecord(recordDir(), String(row.askId))?.deliveredBack).toBe(true)
    }
  })

  it('reports a slow target timing out while the others finish (mode all)', async () => {
    const world = batchWorld([
      { id: 't1', title: '甲会话', answer: '甲的答复' },
      { id: 't2', title: '乙会话', busy: true },
      { id: 't3', title: '丙会话', answer: '丙的答复' },
    ])
    const value = await askSessions(
      { sessionController: world.controller },
      new AbortController().signal,
      batchInput(['t1', 't2', 't3'], { waitMs: 20 }),
    )
    const results = value.results as unknown as Array<Record<string, unknown>>
    expect(results.map((row) => row.state)).toEqual(['done', 'timeout', 'done'])
    expect(results.map((row) => row.answer)).toEqual(['甲的答复', '', '丙的答复'])
    expect(readAskRecord(recordDir(), String(results[1].askId))?.state).toBe('timeout')
  })

  it('mode any returns the first settled target while the rest still settle', async () => {
    const world = batchWorld([
      // Its delivery fails outright, so it should settle before the other target's
      // answer completes — but with the prompt fallback in play the exact winner is
      // timing dependent, which is not what this test is about.
      { id: 't1', title: '甲会话', deliverThrows: { code: 'session/writer-held' } },
      { id: 't2', title: '乙会话', answer: '乙的答复' },
    ])
    const value = await askSessions(
      { sessionController: world.controller },
      new AbortController().signal,
      batchInput(['t1', 't2'], { waitMs: 20, mode: 'any' }),
    )
    expect(value.ok).toBe(true)
    expect(value.skipped).toEqual([])
    expect(value.count).toBe(1)
    const results = value.results as unknown as Array<Record<string, unknown>>
    expect(results).toHaveLength(1)
    const winner = results[0].sessionId
    expect(['t1', 't2']).toContain(winner)
    // The loser keeps running after the call returns; its record still settles.
    const loser = winner === 't1' ? 't2' : 't1'
    await until(() =>
      listAskRecords(recordDir(), { sessionId: SELF }).some(
        (record) => record.targetSessionId === loser && record.state !== 'waiting',
      ),
    )
    const records = listAskRecords(recordDir(), { sessionId: SELF })
    // The losing target still wrote its own settled record; the winner's record is
    // whatever its own state turned out to be. Neither may stay `waiting`.
    expect(records.every((record) => record.state !== 'waiting')).toBe(true)
    expect(records.map((record) => record.targetSessionId)).toContain(loser)
  })

  it('skips excluded, unresolvable and duplicate targets with reasons', async () => {
    const world = batchWorld([
      { id: 't1', title: '甲会话', answer: '甲的答复' },
      { id: 'excluded', title: '被排除的会话' },
    ])
    const value = await askSessions(
      { sessionController: world.controller },
      new AbortController().signal,
      // 't1' and '甲会话' resolve to the same session: the duplicate collapses.
      batchInput(['t1', '甲会话', '不存在', '被排除的会话', ''], {
        waitMs: 20,
        exclude: ['被排除的会话'],
      }),
    )
    expect(value.ok).toBe(true)
    expect(value.count).toBe(1)
    expect((value.results as unknown as unknown as Array<Record<string, unknown>>)[0].sessionId).toBe('t1')
    // The unresolvable target carries the capped recent-session block.
    expect(value.skipped).toHaveLength(3)
    expect(value.skipped[0]?.target).toBe('不存在')
    expect(value.skipped[0]?.reason).toContain('没有找到匹配的会话')
    expect(value.skipped[0]?.reason).toContain('t1')
    expect(value.skipped.slice(1)).toEqual([
      { target: '被排除的会话', reason: '这个会话被设置为不参与蜂群' },
      { target: '', reason: '没点名' },
    ])
  })

  it('skips an archived target with the archived reason', async () => {
    const world = batchWorld([
      { id: 't1', title: '甲会话', answer: '甲的答复' },
      { id: 't2', title: '乙会话', answer: '乙的答复' },
    ])
    const value = await askSessions(
      {
        sessionController: world.controller,
        workspaceRegistry: {
          list: () => [{ sessionIds: ['t1', 't2'] }],
          archivedSessionIds: new Set(['t1']),
        },
      },
      new AbortController().signal,
      batchInput(['t1', 't2'], { waitMs: 20 }),
    )
    expect(value.count).toBe(1)
    expect((value.results as unknown as unknown as Array<Record<string, unknown>>)[0].sessionId).toBe('t2')
    expect(value.skipped).toEqual([{ target: 't1', reason: ARCHIVED_SESSION_MESSAGE }])
  })

  it('skips an unregistered target with its own reason', async () => {
    const world = batchWorld([
      { id: 't1', title: '甲会话', answer: '甲的答复' },
      { id: 't2', title: '乙会话', answer: '乙的答复' },
    ])
    const value = await askSessions(
      {
        sessionController: world.controller,
        // Only t2 is registered; t1 still appears in the raw session list.
        workspaceRegistry: { list: () => [{ sessionIds: ['t2'] }] },
      },
      new AbortController().signal,
      batchInput(['t1', 't2'], { waitMs: 20 }),
    )
    expect(value.count).toBe(1)
    expect((value.results as unknown as unknown as Array<Record<string, unknown>>)[0].sessionId).toBe('t2')
    expect(value.skipped).toEqual([{ target: 't1', reason: UNREGISTERED_SESSION_MESSAGE }])
  })

  it('fails the whole call only when every target is skipped', async () => {
    const world = batchWorld([])
    const value = await askSessions(
      { sessionController: world.controller },
      new AbortController().signal,
      batchInput(['', '不存在'], { waitMs: 20 }),
    )
    expect(value).toEqual({
      ok: false,
      count: 0,
      results: [],
      skipped: [
        { target: '', reason: '没点名' },
        { target: '不存在', reason: '没有找到匹配的会话' },
      ],
    })
  })

  it('applies self and subagent guards per target', async () => {
    const world = batchWorld([
      { id: SELF, title: '本会话' },
      { id: 'sub', title: '子会话', origin: 'subagent' },
      { id: 't3', title: '丙会话', answer: '丙的答复' },
    ])
    const value = await askSessions(
      { sessionController: world.controller },
      new AbortController().signal,
      batchInput([SELF, 'sub', 't3'], { waitMs: 20 }),
    )
    expect(value.count).toBe(1)
    expect((value.results as unknown as unknown as Array<Record<string, unknown>>)[0].sessionId).toBe('t3')
    expect(value.skipped).toEqual([
      { target: SELF, reason: '目标是当前会话自己' },
      { target: 'sub', reason: '目标会话是子代理（subagent）会话' },
    ])
  })

  it('applies the hop guard per target', async () => {
    const world = batchWorld([{ id: 't1', title: '甲会话', answer: '甲的答复' }])
    const value = await askSessions(
      { sessionController: world.controller },
      new AbortController().signal,
      batchInput(['t1'], { waitMs: 20, currentEvents: [userEvent(1, 1, askSource(2))] }),
    )
    expect(value.ok).toBe(false)
    expect(value.skipped).toEqual([{ target: 't1', reason: '本次提问会超过 2 跳转发上限' }])
  })

  it('skips every target with the swarm-disabled reason when the swarm is off', async () => {
    const world = batchWorld([{ id: 't1', title: '甲会话', answer: '甲的答复' }])
    const value = await askSessions(
      { sessionController: world.controller },
      new AbortController().signal,
      batchInput(['t1'], { waitMs: 20, swarmEnabled: false }),
    )
    expect(value.ok).toBe(false)
    expect(value.count).toBe(0)
    expect(value.skipped).toEqual([
      { target: 't1', reason: '蜂群模式已在设置里关闭（设置 → 插件 → 顾问群 → 全局蜂群）。' },
    ])
  })
})

describe('ask_sessions tool contract', () => {
  it('declares the batch parameter and result shape', () => {
    const tools = registerAdvisorTools({} as AdvisorGroupService)
    const tool = tools.find((candidate) => candidate.name === 'ask_sessions')
    expect(tool).toBeDefined()
    const params = tool?.parameters as Record<string, { required?: boolean; type?: string }>
    expect(params.targets?.required).toBe(true)
    expect(params.question?.required).toBe(true)
    expect(params.mode?.type).toBe('string')
    const properties = (
      tool?.output as { schema: { properties: Record<string, unknown> } }
    ).schema.properties
    expect(Object.keys(properties).sort()).toEqual(['count', 'ok', 'results', 'skipped'])
    const results = properties.results as {
      items: { properties: Record<string, unknown> }
    }
    expect(Object.keys(results.items.properties).sort()).toEqual([
      'answer',
      'askId',
      'error',
      'name',
      'note',
      'sessionId',
      'state',
      'status',
    ])
    const skipped = properties.skipped as {
      items: { properties: Record<string, unknown> }
    }
    expect(Object.keys(skipped.items.properties).sort()).toEqual(['reason', 'target'])
  })
})
