/**
 * Durable advisor-group session event vocabulary.
 *
 * These are append-only session-log events (not Cordis events). They are
 * non-surface, log-only events: they do not enter deriveMessages() and must
 * never carry surfaceOp.
 */

export interface AdvisorGroupAdvisorInfo {
  readonly id: string
  readonly name: string
  readonly avatar?: string
}

export interface AdvisorGroupStartData {
  readonly sessionId: string
  readonly turn: number
  readonly step: number
  readonly question: string
  readonly context?: string
  readonly advisors: AdvisorGroupAdvisorInfo[]
}

export interface AdvisorGroupMessageData {
  readonly sessionId: string
  readonly turn: number
  readonly step: number
  readonly role: 'main' | 'advisor' | 'system'
  readonly advisorId?: string
  readonly advisorName?: string
  readonly content: string
  readonly thinking?: string
  readonly round?: number
  /** Stream was cut before a complete body (advisor timeout / network drop). */
  readonly truncated?: { readonly reason: 'timeout' | 'network'; readonly atMs: number }
}

export interface AdvisorGroupDeltaData {
  readonly sessionId: string
  readonly turn: number
  readonly step: number
  readonly advisorId: string
  readonly advisorName?: string
  readonly round?: number
  readonly contentDelta?: string
  readonly thinkingDelta?: string
  readonly done?: boolean
}

export interface AdvisorGroupResumeData {
  readonly sessionId: string
  readonly turn: number
  readonly step: number
}

export interface AdvisorGroupEndData {
  readonly sessionId: string
  readonly turn: number
  readonly step: number
  readonly summary: {
    readonly question: string
    readonly advisors: ReadonlyArray<{
      readonly advisorId: string
      readonly advisorName: string
      readonly corePoints: string[]
    }>
    readonly riskNotes?: string[]
    readonly conclusion?: string
    /** True when the consultation was stopped by the user (partial content). */
    readonly stopped?: boolean
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Opens one advisor-group consultation.
     * @mode emit
     * @param data - stable session id, location, question, and advisor roster.
     */
    'advisor-group/start': AdvisorGroupStartData
    /**
     * Records one durable message in the advisor-group chat.
     * @mode emit
     * @param data - same session id, location, role, optional advisor identity, content, round.
     */
    'advisor-group/message': AdvisorGroupMessageData
    /**
     * Streams one advisor's incremental reply and optional thinking chain.
     * @mode emit
     * @param data - same session id and advisor identity plus text deltas.
     */
    'advisor-group/delta': AdvisorGroupDeltaData
    /**
     * Marks a stopped consultation as resumed (the card returns to LIVE and
     * the remaining rounds continue from the interruption point).
     * @mode emit
     * @param data - same session id and location.
     */
    'advisor-group/resume': AdvisorGroupResumeData
    /**
     * Closes one advisor-group consultation with its final summary.
     * @mode emit
     * @param data - same session id, location, and final summary.
     */
    'advisor-group/end': AdvisorGroupEndData
  }
}

export {}
