import type { AdvisorConfig } from './config'

export interface DriverSource {
  provider: string
  model: string
}

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
  /** Working directory of the agent session (for cross-restart recovery). */
  cwd?: string
  /** The agent's DSH session id: resume rebuilds THIS session so the card
   *  (assembled from the agent session log) keeps receiving events. */
  dshSessionId?: string
  /** Driver model source captured at first run; resume reuses it because the
   *  rebuilt session has no request/header event to read the agent model from. */
  driverSource?: DriverSource
  /** Why the consultation was interrupted: 'user-stop' (explicit stop button),
   *  'exec-cancel' (host signal), 'abort-error' (unclassified AbortError),
   *  or an advisor-level reason mirrored from truncated (timeout/network). */
  stopReason?: string
  createdAt: number
  updatedAt: number
}

/**
 * Durable snapshot of a consultation (one file under
 * `storages/advisor-group/sessions/<id>.json`). Deliberately stores NO
 * credentials: advisors are referenced by id and resolved from the live
 * configuration on resume, so an API key change or removal is honored.
 */
export interface PersistedSession {
  version: 1
  id: string
  status: 'active' | 'completed' | 'cancelled'
  question: string
  context?: string
  cwd?: string
  dshSessionId?: string
  driverSource?: DriverSource
  stopReason?: string
  advisorIds: string[]
  maxRounds: number
  createdAt: number
  updatedAt: number
  messages: Array<{
    role: ChatRole
    advisorId?: string
    advisorName?: string
    content: string
    thinking?: string
    round?: number
    truncated?: TruncationInfo
    ts: number
  }>
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
