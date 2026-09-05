import { describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { appendAdvisorEnd } from '../src/session-log'
import type { ConsultSession, ConsultSummary } from '../src/types'

/**
 * The end event MUST carry `stopped` and `conclusion`: the client derives the
 * card status from `summary.stopped` (STOPPED + ▶ 继续聊天 button) and renders
 * the 📌 综合结论 section from `summary.conclusion`. Dropping them (regression
 * observed in production) makes every stopped consultation look completed.
 */
describe('appendAdvisorEnd carries stopped/conclusion', () => {
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
