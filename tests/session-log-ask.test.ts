import { describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { appendAskAnswer, appendAskStart } from '../src/session-log'

function fakeLog(step?: { turn: number; step: number }): {
  log: Session
  appended: Array<{ type: string; data: unknown }>
} {
  const appended: Array<{ type: string; data: unknown }> = []
  const events =
    step === undefined
      ? []
      : [{ type: 'step/start', data: { turn: step.turn, step: step.step } }]
  const log = {
    snapshotEvents: () => events,
    append: (type: string, data: unknown) => {
      appended.push({ type, data })
    },
  } as unknown as Session
  return { log, appended }
}

describe('appendAskStart opens the cross-session card', () => {
  it('writes kind:ask with both session members, the question, and the tool step', () => {
    const { log, appended } = fakeLog({ turn: 2, step: 3 })
    appendAskStart(log, {
      askId: 'ask-1',
      question: '问题原文',
      senderName: '提问方',
      targetName: '构建会话',
    })
    expect(appended).toHaveLength(1)
    expect(appended[0]?.type).toBe('advisor-group/start')
    const data = appended[0]?.data as Record<string, unknown>
    // kind:'ask' is the ONLY marker that switches the client into the ask
    // layout; the event type itself stays the registered advisor-group one.
    expect(data.kind).toBe('ask')
    expect(data.sessionId).toBe('ask-1')
    expect(data.turn).toBe(2)
    expect(data.step).toBe(3)
    expect(data.question).toBe('问题原文')
    expect(data.advisors).toEqual([
      { id: 'ask-sender', name: '提问方' },
      { id: 'ask-target', name: '构建会话' },
    ])
    // Session.append rejects undefined values — the key must be absent.
    expect(Object.hasOwn(data, 'context')).toBe(false)
  })

  it('carries the optional background into the context field', () => {
    const { log, appended } = fakeLog()
    appendAskStart(log, {
      askId: 'ask-2',
      question: 'q',
      context: '背景',
      senderName: 'A',
      targetName: 'B',
    })
    expect((appended[0]?.data as { context?: string }).context).toBe('背景')
  })
})

describe('appendAskAnswer closes the cross-session card', () => {
  it('appends the answer bubble before the end event, conclusion = note', () => {
    const { log, appended } = fakeLog({ turn: 4, step: 5 })
    appendAskAnswer(log, {
      askId: 'ask-1',
      question: '问题原文',
      targetName: '构建会话',
      answer: '对方的回复',
      note: '区间语义说明……',
    })
    // Message BEFORE end: the assembled state must hold the answer by the
    // time the status flips to completed.
    expect(appended.map((entry) => entry.type)).toEqual([
      'advisor-group/message',
      'advisor-group/end',
    ])
    const message = appended[0]?.data as Record<string, unknown>
    expect(message.role).toBe('advisor')
    expect(message.advisorId).toBe('ask-target')
    expect(message.advisorName).toBe('构建会话')
    expect(message.content).toBe('对方的回复')
    expect(message.turn).toBe(4)
    expect(message.step).toBe(5)
    const end = appended[1]?.data as { summary: Record<string, unknown> }
    expect(end.summary.conclusion).toBe('区间语义说明……')
    expect(end.summary.question).toBe('问题原文')
    // No stopped key: the card must land on completed, never on the
    // cancelled state with its ▶ 继续聊天 button.
    expect(Object.hasOwn(end.summary, 'stopped')).toBe(false)
  })

  it('renders a placeholder when the wait produced no answer', () => {
    const { log, appended } = fakeLog()
    appendAskAnswer(log, {
      askId: 'ask-3',
      question: 'q',
      targetName: 'B',
      answer: '   ',
      note: '超时说明',
    })
    const message = appended[0]?.data as { content?: string }
    expect(message.content).toContain('未收到回复')
  })
})
