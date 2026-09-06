import { describe, expect, it } from 'vitest'
import {
  advisorGroupDefinition,
  buildStepSequence,
  buildToolStepViews,
  extractActionDescription,
  sanitizeClientContent,
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

describe('client live-overlay sanitize (raw tool markup must not render)', () => {
  it('cleans the raw plain block same as the host side', () => {
    expect(
      sanitizeClientContent('正文。\n<tool_calls>\n<invoke name="grep">\n</invoke>\n</tool_calls>\n补充。'),
    ).toBe('正文。\n\n补充。')
  })

  it('cuts the unclosed piped DSML variant (live overlay keeps raw stream)', () => {
    expect(
      sanitizeClientContent(
        '结论：需要核对。\n\n<｜｜tool_calls>\n<｜｜DSML｜\n<invoke name="pwsh">\n</invoke>\n',
      ),
    ).toBe('结论：需要核对。')
  })

  it('normal text and empty input stay untouched', () => {
    expect(sanitizeClientContent('正常')).toBe('正常')
    expect(sanitizeClientContent('')).toBe('')
  })

  it('strips a MID-LINE tool_calls block on the live overlay side too', () => {
    expect(
      sanitizeClientContent(
        '直接证据。<tool_calls><invoke name="bash"><parameter name="command" string="true">ls</parameter></invoke></tool_calls>',
      ),
    ).toBe('直接证据。')
  })
})

describe('tool step views (one row per invocation, 输入/输出)', () => {
  it('pairs call + result into one view and drops internal announcements', () => {
    const steps = [
      { kind: 'call', name: '⚙️ tools', text: '本次可用：read、grep', atMs: 1 },
      { kind: 'call', name: 'read', text: '{"path":"a.txt"}', atMs: 2 },
      { kind: 'result', name: 'read', text: 'FILE: hello', atMs: 3 },
      { kind: 'call', name: 'grep', text: '{"pattern":"x"}', atMs: 4 },
    ]
    expect(buildToolStepViews(steps)).toEqual([
      { name: 'read', input: '{"path":"a.txt"}', output: 'FILE: hello', atMs: 2 },
      { name: 'grep', input: '{"pattern":"x"}', output: undefined, atMs: 4 },
    ])
  })

  it('keeps a solo result as its own view', () => {
    expect(
      buildToolStepViews([{ kind: 'result', name: 'read', text: 'out', atMs: 5 }]),
    ).toEqual([{ name: 'read', input: undefined, output: 'out', atMs: 5 }])
  })

  it('marks failed executions (工具执行失败) in the view', () => {
    expect(
      buildToolStepViews([
        { kind: 'call', name: 'bash', text: '{}', atMs: 1 },
        { kind: 'result', name: 'bash', text: '（工具执行失败：401 Unauthorized）', atMs: 2 },
      ]),
    ).toEqual([{ name: 'bash', input: '{}', output: '（工具执行失败：401 Unauthorized）', failed: true, atMs: 1 }])
  })

  it('marks JSON error payloads as failed too (unconfigured 401 tools)', () => {
    expect(
      buildToolStepViews([
        { kind: 'call', name: 'hindsight_sync_status', text: '{}', atMs: 1 },
        { kind: 'result', name: 'hindsight_sync_status', text: '{"error":"GET ... 401 Authentication failed"}', atMs: 2 },
      ])[0]?.failed,
    ).toBe(true)
  })

  it('marks nested JSON error payloads as failed (robust to objects before error)', () => {
    expect(
      buildToolStepViews([
        { kind: 'call', name: 'tool', text: '{}', atMs: 1 },
        { kind: 'result', name: 'tool', text: '{"meta":{"x":1},"error":"GET ... 401"}', atMs: 2 },
      ])[0]?.failed,
    ).toBe(true)
    // Normal JSON success must NOT be flagged.
    expect(
      buildToolStepViews([
        { kind: 'call', name: 'read', text: '{}', atMs: 1 },
        { kind: 'result', name: 'read', text: '{"path":"a.txt","content":"hello"}', atMs: 2 },
      ])[0]?.failed,
    ).toBeFalsy()
  })

  it('returns empty for undefined or pure-internal steps', () => {
    expect(buildToolStepViews(undefined)).toEqual([])
    expect(buildToolStepViews([{ kind: 'call', name: '⚙️ tools', text: 'x', atMs: 1 }])).toEqual([])
  })
})

describe('step sequence (每一步行动行/思考行/工具行/正文行, 官方顺序)', () => {
  it('interleaves action → thinking → tool per round, body last', () => {
    const seq = buildStepSequence(['行动1', '行动2'], ['想1', '想2'], [
      { name: 'read', input: '{}', output: 'x' },
      { name: 'grep', input: '{}', output: 'y' },
    ])
    expect(seq.map((item) => item.kind)).toEqual(['action', 'thinking', 'tool', 'action', 'thinking', 'tool', 'body'])
    expect(seq[0]).toEqual({ kind: 'action', text: '行动1', step: 1 })
    expect(seq[1]).toEqual({ kind: 'thinking', segment: '想1', step: 1 })
    // Official block order is action -> thinking -> tool for each step.
    expect(seq[5]).toEqual({ kind: 'tool', view: { name: 'grep', input: '{}', output: 'y' } })
  })

  it('derives an action row from the thinking segment when actionDescriptions are absent', () => {
    const seq = buildStepSequence([], ['全部思考'], [])
    expect(seq.map((item) => item.kind)).toEqual(['action', 'thinking', 'body'])
    expect(seq[0]).toEqual({ kind: 'action', text: '全部思考', step: 1 })
  })

  it('keeps tool-only messages ordered, body last', () => {
    const seq = buildStepSequence([], [], [{ name: 'bash', input: 'ls', output: 'ok' }])
    expect(seq.map((item) => item.kind)).toEqual(['tool', 'body'])
  })

  it('renders action + tool + body for no-thinking models with narration text', () => {
    const seq = buildStepSequence(['我先读取 package.json'], [], [
      { name: 'read', input: '{}', output: 'x' },
    ])
    expect(seq.map((item) => item.kind)).toEqual(['action', 'tool', 'body'])
    expect(seq[0]).toEqual({ kind: 'action', text: '我先读取 package.json', step: 1 })
  })

  it('renders only body when a no-thinking model answers without tools or narration', () => {
    const seq = buildStepSequence([], [], [])
    expect(seq.map((item) => item.kind)).toEqual(['body'])
  })
})

describe('action description extraction (📋 行动·N before 💭 思考·N)', () => {
  it('prefers the first SHORT action sentence (我先做…/下一步…)', () => {
    const segment =
      '我先做两步实机验证：先检索记忆库中关于显示层的既有知识，再查会话页列表，然后给出结论。\n\n' +
      "I'm the advisor and this is a long internal monologue.".repeat(5)
    expect(extractActionDescription(segment)).toBe(
      '我先做两步实机验证：先检索记忆库中关于显示层的既有知识，再查会话页列表，然后给出结论。',
    )
  })

  it('skips generic intros (让我理解…/我是…) and takes the first real sentence', () => {
    const segment = '让我理解一下任务。\n\n我的角色是顾问A。\n\n关键点：这是关于 DSH 插件的实机验证。'
    expect(extractActionDescription(segment)).toBe('关键点：这是关于 DSH 插件的实机验证。')
  })

  it('caps long/noisy sentences at ~100-140 chars', () => {
    const segment = `${'先做核验。'.repeat(250)}后续继续。`
    const description = extractActionDescription(segment)
    expect(description.length).toBeLessThanOrEqual(142)
    expect(description).toBe('先做核验。')
  })

  it('returns empty for empty input', () => {
    expect(extractActionDescription('')).toBe('')
  })
})
