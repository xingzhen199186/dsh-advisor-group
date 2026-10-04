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
    ...(message.thinkingSegments === undefined ? {} : { thinkingSegments: message.thinkingSegments }),
    ...(message.actionDescriptions === undefined ? {} : { actionDescriptions: message.actionDescriptions }),
    ...(message.toolSteps === undefined ? {} : { toolSteps: message.toolSteps }),
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
    ...(delta.toolStep === undefined ? {} : { toolStep: delta.toolStep }),
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
      // stopped / conclusion MUST reach the client: the card flips to STOPPED
      // (showing the ▶ 继续聊天 button) only when `summary.stopped` is true,
      // and the 📌 综合结论 section renders `summary.conclusion`.
      ...(summary.stopped === undefined ? {} : { stopped: summary.stopped }),
      ...(summary.conclusion === undefined ? {} : { conclusion: summary.conclusion }),
    },
  }
  log.append('advisor-group/end', data)
}

/* --------------------------- Cross-session ask card --------------------------- */

export interface AskCardStartInfo {
  readonly askId: string
  readonly question: string
  readonly context?: string
  readonly senderName: string
  readonly targetName: string
}

/**
 * Open the cross-session ask card (waiting state). Reuses the registered
 * `advisor-group/start` event with `kind:'ask'` so no new event type needs
 * persistence registration; the client branches on `kind` for the ask layout.
 */
export function appendAskStart(log: Session, info: AskCardStartInfo): void {
  const { turn, step } = latestTurnStep(log)
  log.append('advisor-group/start', {
    sessionId: info.askId,
    turn,
    step,
    kind: 'ask',
    question: info.question,
    ...(info.context === undefined ? {} : { context: info.context }),
    advisors: [
      { id: 'ask-sender', name: info.senderName },
      { id: 'ask-target', name: info.targetName },
    ],
  })
}

export interface AskCardAnswerInfo {
  readonly askId: string
  readonly question: string
  readonly targetName: string
  /** Interval narrative (channel + how the wait ended); becomes 📌 投递说明. */
  readonly note: string
  /** Target's answer text; empty on timeout/error — rendered as a placeholder. */
  readonly answer: string
}

/**
 * Close the cross-session ask card: the target's answer as an advisor-role
 * bubble, then the end event whose `summary.conclusion` is the note line.
 * Message is appended BEFORE end so the assembled state has the answer in
 * place when the status flips to completed.
 */
export function appendAskAnswer(log: Session, info: AskCardAnswerInfo): void {
  const { turn, step } = latestTurnStep(log)
  log.append('advisor-group/message', {
    sessionId: info.askId,
    turn,
    step,
    role: 'advisor',
    advisorId: 'ask-target',
    advisorName: info.targetName,
    content: info.answer.trim()
      ? info.answer
      : '（未收到回复，详见下方投递说明）',
  })
  log.append('advisor-group/end', {
    sessionId: info.askId,
    turn,
    step,
    summary: {
      question: info.question,
      advisors: [{ advisorId: 'ask-target', advisorName: info.targetName, corePoints: [] }],
      conclusion: info.note,
    },
  })
}
