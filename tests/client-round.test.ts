import { describe, expect, it } from 'vitest'
import {
  advisorGroupDefinition,
  type AdvisorGroupState,
} from '../src/client/index'

function baseState(): AdvisorGroupState {
  return {
    sessionId: 'session-1',
    turn: 1,
    step: 1,
    question: '问题',
    advisors: [{ id: 'advisor-a', name: '顾问A' }],
    messages: [
      {
        sessionId: 'session-1',
        turn: 1,
        step: 1,
        role: 'main',
        content: '问题',
      },
    ],
    status: 'running',
  }
}

function update(
  state: AdvisorGroupState,
  type: string,
  data: Record<string, unknown>,
): AdvisorGroupState {
  const match = { event: { type, data } }
  return advisorGroupDefinition.update(
    { state } as Parameters<typeof advisorGroupDefinition.update>[0],
    match as Parameters<typeof advisorGroupDefinition.update>[1],
  )
}

describe('advisor-group client round matching', () => {
  it('creates a new bubble for a new round instead of merging into an older round', () => {
    let state = baseState()
    state = update(state, 'advisor-group/delta', {
      sessionId: 'session-1',
      turn: 1,
      step: 1,
      advisorId: 'advisor-a',
      advisorName: '顾问A',
      round: 1,
      contentDelta: '第一轮内容',
    })
    state = update(state, 'advisor-group/delta', {
      sessionId: 'session-1',
      turn: 1,
      step: 1,
      advisorId: 'advisor-a',
      advisorName: '顾问A',
      round: 2,
      contentDelta: '第二轮内容',
    })

    const advisorMessages = state.messages.filter((message) => message.role === 'advisor')
    expect(advisorMessages).toHaveLength(2)
    expect(advisorMessages[0]?.round).toBe(1)
    expect(advisorMessages[0]?.content).toBe('第一轮内容')
    expect(advisorMessages[1]?.round).toBe(2)
    expect(advisorMessages[1]?.content).toBe('第二轮内容')
  })

  it('upserts the final message into the delta-built bubble of the same round', () => {
    let state = baseState()
    state = update(state, 'advisor-group/delta', {
      sessionId: 'session-1',
      turn: 1,
      step: 1,
      advisorId: 'advisor-a',
      advisorName: '顾问A',
      round: 1,
      contentDelta: '部分内容',
    })
    state = update(state, 'advisor-group/message', {
      sessionId: 'session-1',
      turn: 1,
      step: 1,
      role: 'advisor',
      advisorId: 'advisor-a',
      advisorName: '顾问A',
      round: 1,
      content: '完整内容',
    })

    const advisorMessages = state.messages.filter((message) => message.role === 'advisor')
    expect(advisorMessages).toHaveLength(1)
    expect(advisorMessages[0]?.round).toBe(1)
    expect(advisorMessages[0]?.content).toBe('完整内容')
  })

  it('sets status to completed on advisor-group/end', () => {
    let state = baseState()
    state = update(state, 'advisor-group/end', {
      sessionId: 'session-1',
      turn: 1,
      step: 1,
      summary: { question: '问题', advisors: [] },
    })
    expect(state.status).toBe('completed')
  })
})
