import type { Session } from '@deepseek-ai/dsh-session'
import './session-events'
import type {
  AdvisorGroupDeltaData,
  AdvisorGroupEndData,
  AdvisorGroupMessageData,
  AdvisorGroupStartData,
} from './session-events'
import type { ChatMessage, ConsultSession, ConsultSummary } from './types'

/**
 * Derive the latest turn/step from the durable session log.
 *
 * ToolRunContext does not expose turn/step directly. The agent loop logs
 * `turn/start` and `step/start` before tool execution, so scanning backwards
 * gives the closest coordinates; fallback to 0 when none exist.
 */
export function latestTurnStep(log: Session): { turn: number; step: number } {
  const events = log.snapshotEvents()
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event.type === 'step/start') {
      return { turn: event.data.turn, step: event.data.step }
    }
    if (event.type === 'turn/start') {
      return { turn: event.data.turn, step: 0 }
    }
  }
  return { turn: 0, step: 0 }
}

export function appendAdvisorStart(log: Session, session: ConsultSession): void {
  const { turn, step } = latestTurnStep(log)
  const advisors: AdvisorGroupStartData['advisors'] = session.advisors.map(
    ({ id, name, avatar }) =>
      avatar === undefined ? { id, name } : { id, name, avatar },
  )
  log.append('advisor-group/start', {
    sessionId: session.id,
    turn,
    step,
    question: session.question,
    ...(session.context === undefined ? {} : { context: session.context }),
    advisors,
  })
}

export function appendAdvisorMessage(
  log: Session,
  sessionId: string,
  message: ChatMessage,
): void {
  const { turn, step } = latestTurnStep(log)
  const data: AdvisorGroupMessageData = {
    sessionId,
    turn,
    step,
    role: message.role,
    content: message.content,
    ...(message.advisorId === undefined ? {} : { advisorId: message.advisorId }),
    ...(message.advisorName === undefined ? {} : { advisorName: message.advisorName }),
    ...(message.round === undefined ? {} : { round: message.round }),
    ...(message.thinking === undefined ? {} : { thinking: message.thinking }),
    ...(message.truncated === undefined ? {} : { truncated: message.truncated }),
  }
  log.append('advisor-group/message', data)
}

export function appendAdvisorDelta(
  log: Session,
  sessionId: string,
  delta: Omit<AdvisorGroupDeltaData, 'turn' | 'step'>,
): void {
  const { turn, step } = latestTurnStep(log)
  // Session.append rejects undefined values. Build the payload explicitly so
  // optional fields (contentDelta / thinkingDelta / done / round) are omitted
  // instead of present-as-undefined.
  const data: AdvisorGroupDeltaData = {
    sessionId,
    turn,
    step,
    advisorId: delta.advisorId,
    ...(delta.advisorName === undefined ? {} : { advisorName: delta.advisorName }),
    ...(delta.round === undefined ? {} : { round: delta.round }),
    ...(delta.contentDelta === undefined ? {} : { contentDelta: delta.contentDelta }),
    ...(delta.thinkingDelta === undefined ? {} : { thinkingDelta: delta.thinkingDelta }),
    ...(delta.done === undefined ? {} : { done: delta.done }),
  }
  log.append('advisor-group/delta', data)
}

export function appendAdvisorResume(log: Session, sessionId: string): void {
  const { turn, step } = latestTurnStep(log)
  log.append('advisor-group/resume', {
    sessionId,
    turn,
    step,
  })
}

export function appendAdvisorEnd(
  log: Session,
  session: ConsultSession,
  summary: ConsultSummary,
): void {
  const { turn, step } = latestTurnStep(log)
  const data: AdvisorGroupEndData = {
    sessionId: session.id,
    turn,
    step,
    summary: {
      question: summary.question,
      advisors: summary.advisors.map(({ advisorId, advisorName, corePoints }) => ({
        advisorId,
        advisorName,
        corePoints,
      })),
      ...(summary.riskNotes.length > 0 ? { riskNotes: summary.riskNotes } : {}),
    },
  }
  log.append('advisor-group/end', data)
}
