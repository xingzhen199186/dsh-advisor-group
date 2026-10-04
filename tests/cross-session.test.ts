import { describe, expect, it, vi } from 'vitest'

// The real @deepseek-ai/dsh-tools pulls @deepseek-ai/dsh-sandbox, a host peer
// that is not installed here (same reason tests/tools-schema.test.ts mocks it).
vi.mock('@deepseek-ai/dsh-tools', () => ({
  defineTool: (options: unknown) => options,
}))

import {
  ASK_CONTENT_MAX_BYTES,
  ASK_HOP_LIMIT,
  ASK_WAIT_DEFAULT_MS,
  ASK_WAIT_MAX_MS,
  askContentBytes,
  askSession,
  buildAskEnvelope,
  buildAskMessage,
  checkAskGuards,
  collectAnswer,
  fallbackSessionName,
  getSessionController,
  isSubagentDeliveryRejection,
  joinAnswerPieces,
  logWatermark,
  matchTargetSession,
  nextAskHop,
  normalizeWaitMs,
  renderAskResult,
  resetPendingWaits,
  sessionDisplayName,
  waitForTargetIdle,
  type AskCardDelivery,
  type AskCardSettle,
  type CrossSessionAgent,
  type CrossSessionController,
  type CrossSessionLogEvent,
  type CrossSessionSummary,
  type SessionAskMessageSource,
} from '../src/cross-session'
import { registerAdvisorTools } from '../src/tools'
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
  return summary({ sessionId, projections: { values: { title: { title } } }, ...extra })
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

  it('reports a missing target rather than picking something close', () => {
    const rejection = checkAskGuards({
      guards: { currentSessionId: SELF, hop: 0 },
      match: { kind: 'missing' },
      sessions: [],
      question: 'q',
    })
    expect(rejection?.code).toBe('target-not-found')
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
    expect(delivered.content[0]).toEqual({ type: 'text', text: '【来自会话「提问方」的提问】' })
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
    expect(delivered.content[0].text).toBe('【来自会话「提问方」的提问】')
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
    ])
  })

  it('requires target and question, and never claims the reply is a one-to-one answer', () => {
    const params = tool?.parameters as Record<string, { description?: string; required?: boolean }>
    expect(params.target?.required).toBe(true)
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
      'error',
      'interval',
      'message',
      'note',
      'ok',
      'target',
    ])
  })

  it('returns a structured error instead of throwing when the host lacks the service', async () => {
    const bare = registerAdvisorTools({} as AdvisorGroupService).find(
      (candidate) => candidate.name === 'ask_session',
    )
    const execute = bare?.execute as (args: unknown, exec: unknown) => Promise<Record<string, unknown>>
    const value = await execute({ target: TARGET, question: 'q' }, { signal: new AbortController().signal })
    expect(value).toMatchObject({ ok: false, error: 'service-missing', answer: '', note: '' })
    expect((value.interval as { endedBecause: string }).endedBecause).toBe('error')
  })
})
