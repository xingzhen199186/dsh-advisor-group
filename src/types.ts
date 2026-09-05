import type { AdvisorConfig } from './config'

export type ChatRole = 'main' | 'advisor' | 'system'

/** Why an advisor stream ended before producing a complete answer body. */
export interface TruncationInfo {
  reason: 'timeout' | 'network'
  atMs: number
}

export interface ChatMessage {
  role: ChatRole
  advisorId?: string
  advisorName?: string
  content: string
  thinking?: string
  round?: number
  /** Set when the stream was cut before a complete body (e.g. advisor timeout). */
  truncated?: TruncationInfo
  ts: number
}

export interface ConsultSession {
  id: string
  status: 'active' | 'completed' | 'cancelled'
  question: string
  context?: string
  advisors: AdvisorConfig[]
  maxRounds: number
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
}

export interface ClassifierResult {
  shouldEscalate: boolean
  reason: string
  suggestedAdvisors: string[]
  suggestWebSearch: boolean
}

export interface AdvisorSummary {
  advisorId: string
  advisorName: string
  corePoints: string[]
  uncertainty?: string
}

export interface ConsultSummary {
  sessionId: string
  question: string
  advisors: AdvisorSummary[]
  consensus: string[]
  disagreements: string[]
  riskNotes: string[]
  /** Driver-model synthesis appended after all auto-deepen rounds (2026-09-05). */
  conclusion?: string
  /** True when the consultation was stopped by the user (partial content). */
  stopped?: boolean
}
