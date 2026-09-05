import type { ChatMessage, ConsultSession, ConsultSummary } from './types'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'advisor-group/session-start'(session: ConsultSession): void
    'advisor-group/message'(payload: { sessionId: string; message: ChatMessage }): void
    'advisor-group/delta'(payload: {
      sessionId: string
      turn: number
      step: number
      advisorId: string
      advisorName?: string
      contentDelta?: string
      thinkingDelta?: string
      done?: boolean
    }): void
    'advisor-group/session-end'(payload: { sessionId: string; summary: ConsultSummary }): void
    'advisor-group/resume'(payload: { sessionId: string }): void
  }
}

export {}
