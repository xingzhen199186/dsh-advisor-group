import { describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { appendAdvisorEnd } from '../src/session-log'
import type { ConsultSession, ConsultSummary } from '../src/types'

function fakeLog(): { log: Session; captured: unknown } {
  const captured: { type?: string; data?: unknown } = {}
  const log = {
    snapshotEvents: () => [],
    append: (type: string, data: unknown) => {
      captured.type = type
      captured.data = data
    },
  } as unknown as Session
  return { log, captured }
}

const session = {
  id: 'consult-1',
  question: '问题',
  advisors: [],
  messages: [],
  maxRounds: 3,
  createdAt: 0,
  updatedAt: 0,
} as unknown as ConsultSession

/**
 * The end event MUST carry `stopped` and `conclusion`: the client derives the
 * card status from `summary.stopped` (STOPPED + ▶ 继续聊天 button) and renders
 * the 📌 综合结论 section from `summary.conclusion`. Dropping them (regression
 * observed in production) makes every stopped consultation look completed.
 */
describe('appendAdvisorEnd carries stopped/conclusion', () => {
  it('writes stopped:true and no conclusion for a stopped consultation', () => {
    const { log, captured } = fakeLog()
    const summary = {
      sessionId: 'consult-1',
      question: '问题',
      advisors: [],
      consensus: [],
      disagreements: [],
      riskNotes: [],
      stopped: true,
    } as ConsultSummary
    appendAdvisorEnd(log, session, summary)
    const data = (captured as { data?: { summary?: Record<string, unknown> } }).data?.summary ?? {}
    expect(data.stopped).toBe(true)
    expect(data.conclusion).toBeUndefined()
  })

  it('writes conclusion for a completed consultation without stopped', () => {
    const { log, captured } = fakeLog()
    const summary = {
      sessionId: 'consult-1',
      question: '问题',
      advisors: [],
      consensus: [],
      disagreements: [],
      riskNotes: [],
      conclusion: '综合结论正文',
    } as ConsultSummary
    appendAdvisorEnd(log, session, summary)
    const data = (captured as { data?: { summary?: Record<string, unknown> } }).data?.summary ?? {}
    expect(data.conclusion).toBe('综合结论正文')
    expect(data.stopped).toBeUndefined()
  })
})

// 2026-09-26 实机会话（bab555f3）双端取证：卡片从本事件的 summary.riskNotes
// 渲染琥珀风险块，ask_advisors 工具返回格式化的是同一个 summary 数组。此处锁
// 卡片侧线格式——非空逐字节透传（与工具返回同文案），空数组必须整个键省略，
// 否则卡片会画出空块。
describe('appendAdvisorEnd serializes riskNotes (card-side wire contract)', () => {
  const RISK_NOTE = '部分顾问提到了风险、不确定性或置信度较低，请主模型谨慎采用。'

  it('passes a non-empty riskNotes array through byte-exact', () => {
    const { log, captured } = fakeLog()
    const summary = {
      sessionId: 'consult-1',
      question: '问题',
      advisors: [],
      consensus: [],
      disagreements: [],
      riskNotes: [RISK_NOTE],
      conclusion: '综合结论正文',
    } as ConsultSummary
    appendAdvisorEnd(log, session, summary)
    const data = (captured as { data?: { summary?: Record<string, unknown> } }).data?.summary ?? {}
    expect(data.riskNotes).toEqual([RISK_NOTE])
  })

  it('omits the riskNotes key entirely when the array is empty', () => {
    const { log, captured } = fakeLog()
    const summary = {
      sessionId: 'consult-1',
      question: '问题',
      advisors: [],
      consensus: [],
      disagreements: [],
      riskNotes: [],
    } as ConsultSummary
    appendAdvisorEnd(log, session, summary)
    const data = (captured as { data?: { summary?: Record<string, unknown> } }).data?.summary ?? {}
    expect(Object.hasOwn(data, 'riskNotes')).toBe(false)
  })
})
