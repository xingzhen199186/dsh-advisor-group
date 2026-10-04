/**
 * Cross-session ask (v0): let the current session deliver one question to
 * another existing ordinary session, wake it, and report what that session
 * said between the delivery receipt and its next whole-session idle.
 *
 * Facts this module is built on (DSH 0.2.0-rc.1/rc.2 types, verified):
 * - `ctx.sessionController.resolveAgent(sessionId)` yields the live Agent
 *   (`{ agent }` or `{ error }`), resuming a cold session.
 * - `agent.followup(createUserMessage({ content, source }))` queues one
 *   ordinary follow-up turn and wakes the driver.
 * - `ctx.sessionController.prompt({ sessionId, content, mode:'queue', requestId })`
 *   is the cheap fallback, but the Host hardcodes `source` to a user prompt, so
 *   that path is identity-dishonest and must be reported as such.
 * - There is NO API that returns "the answer to this message". The Host only
 *   guarantees delivery, so this module reports an INTERVAL, never a reply.
 * - The Host enforces no caller identity, no cycle guard, and hard-excludes
 *   subagent sessions, so every guard in `ask_session` lives here.
 *
 * The pure helpers below never touch `ctx`; only `askSession()` does I/O.
 */
import { createUserMessage, type ContentBlock, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Maximum combined UTF-8 bytes of question + context (design §六.5). */
export const ASK_CONTENT_MAX_BYTES = 32000
/** Default and maximum wait for the target's next idle (design §十). */
export const ASK_WAIT_DEFAULT_MS = 180000
export const ASK_WAIT_MAX_MS = 600000
/**
 * Maximum hop count. `hop` counts how many session-ask relays a question has
 * already travelled; a delivery that would make it 3 is refused
 * (design §十: "默认最多 2 跳").
 */
export const ASK_HOP_LIMIT = 2
/** Poll interval while waiting for the target to reach whole-session idle. */
export const ASK_POLL_INTERVAL_MS = 1000
/** Same-session guard: the value is a plain string, not the branded SessionId. */
export type TargetSessionId = string

// ---------------------------------------------------------------------------
// Source vocabulary (declaration merging, following team-message/agent-message)
// ---------------------------------------------------------------------------

/**
 * Producer-declared source of a message one session sends to another.
 * `form: 'relay'` is the Host's own word for "a message another agent addressed
 * to this one"; we must not invent a form of our own.
 */
export type SessionAskMessageSource = {
  readonly kind: 'session-ask'
  readonly form: 'relay'
  /** Unique id; the receiver side may deduplicate on it. */
  readonly askId: string
  readonly senderSessionId: string
  readonly senderName: string
  /** Relays travelled so far; the receiving session raises it by one on a re-ask. */
  readonly hop: number
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'session-ask': SessionAskMessageSource
  }
}

// ---------------------------------------------------------------------------
// Minimal structural views of host objects (not every host package is installed)
// ---------------------------------------------------------------------------

/** The one event shape this module reads: `assistant/message` on a session log. */
export interface CrossSessionLogEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: {
    readonly message: { readonly content: readonly ContentBlock[] }
  }
}

/** Minimal live-Agent view: we only deliver and read the log back. */
export interface CrossSessionAgent {
  readonly session?: {
    readonly id?: string
    readonly header?: { readonly cwd?: string }
    snapshotEvents(): readonly CrossSessionLogEvent[]
  }
  followup(message: UserMessage): void
}

/** One `sessionController.list()` row, narrowed to the fields this module reads. */
export interface CrossSessionSummary {
  readonly sessionId: string
  readonly updatedAt: number
  readonly running: boolean
  readonly cwd?: string
  readonly parentSessionId?: string
  readonly origin?: 'subagent'
  readonly agentAvailable?: boolean
  readonly projections?: {
    readonly values?: { readonly title?: unknown }
  }
}

export type CrossSessionAgentResult =
  | { readonly agent: CrossSessionAgent }
  | { readonly error?: unknown }

/** Lazy host-service view; `sessionController` is absent on older hosts. */
export interface CrossSessionController {
  list(
    request: { readonly cursor?: string },
    signal: AbortSignal,
  ): Promise<{ readonly items: readonly CrossSessionSummary[] }>
  resolveAgent(sessionId: string): Promise<CrossSessionAgentResult>
  prompt(request: {
    readonly requestId: string
    readonly sessionId: string
    readonly mode: 'queue' | 'steer'
    readonly content: readonly ContentBlock[]
  }): Promise<unknown>
}

export type CrossSessionDelivery = 'native' | 'fallback'
export type CrossSessionEndReason = 'idle' | 'timeout' | 'error'
export type CrossSessionErrorCode =
  | 'target-ambiguous'
  | 'target-not-found'
  | 'self-target'
  | 'subagent-target'
  | 'hop-limit'
  | 'already-waiting'
  | 'content-too-large'
  | 'service-missing'
  | 'delivery-failed'
  | 'delivery-rejected'

export interface CrossSessionTarget {
  readonly sessionId: string
  readonly name: string
}

export interface CrossSessionCandidate {
  readonly sessionId: string
  readonly name: string
  readonly hint: string
}

export interface CrossSessionInterval {
  readonly from: string
  readonly to: string | null
  readonly endedBecause: CrossSessionEndReason
}

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

/**
 * Envelope the receiving model reads. The Host offers no registration point for
 * this framing (the official Agent Teams build their own too), so the identity
 * is carried in the content itself: a header block naming the asking session,
 * then the question, then optional background.
 * @param senderName - title (or cwd+time fallback) of the asking session.
 * @param question - the question to hand over.
 * @param context - optional background; permanently recorded in the target log.
 * @returns content blocks, envelope first.
 */
export function buildAskEnvelope(
  senderName: string,
  question: string,
  context?: string,
): ContentBlock[] {
  const blocks: ContentBlock[] = [
    { type: 'text', text: `【来自会话「${senderName}」的提问】` },
    { type: 'text', text: question },
  ]
  if (context !== undefined && context.trim().length > 0) {
    blocks.push({ type: 'text', text: `【对方补充的背景】\n${context}` })
  }
  return blocks
}

/**
 * Build the identified user message handed to `agent.followup()`.
 * @param envelope - content blocks produced by {@link buildAskEnvelope}.
 * @param source - producer-declared session-ask source.
 * @returns an immutable identified user message carrying our source kind.
 */
export function buildAskMessage(envelope: ContentBlock[], source: SessionAskMessageSource): UserMessage {
  return createUserMessage({ content: envelope, source })
}

/**
 * UTF-8 byte length of the text a caller wants to hand over.
 * @param question - the question text.
 * @param context - optional background text.
 * @returns byte length of question + context.
 */
export function askContentBytes(question: string, context?: string): number {
  return Buffer.byteLength(question, 'utf8') + (context === undefined ? 0 : Buffer.byteLength(context, 'utf8'))
}

/** Deterministic fallback label: working directory plus most recent activity. */
export function fallbackSessionName(cwd: string | undefined, updatedAt: number | undefined): string {
  const where = cwd === undefined || cwd.length === 0 ? '（未知工作目录）' : cwd
  if (updatedAt === undefined || !Number.isFinite(updatedAt)) return where
  const at = new Date(updatedAt)
  const stamp = Number.isNaN(at.getTime()) ? String(updatedAt) : at.toISOString()
  return `${where} · ${stamp}`
}

/**
 * Model-visible name of one listed session. The title lives in the `title`
 * projection (a snapshot object), is optional, and may be a stale cache value,
 * so every failure degrades to the cwd+time fallback instead of throwing.
 */
export function sessionDisplayName(summary: CrossSessionSummary): string {
  const raw = summary.projections?.values?.title
  const title =
    raw !== null && typeof raw === 'object' && typeof (raw as { readonly title?: unknown }).title === 'string'
      ? (raw as { readonly title: string }).title.trim()
      : ''
  if (title.length > 0) return title
  return fallbackSessionName(summary.cwd, summary.updatedAt)
}

/** Matching outcome for one target reference: exact id, unique title, ambiguous, or none. */
export type TargetMatch =
  | { readonly kind: 'unique'; readonly target: CrossSessionTarget }
  | { readonly kind: 'ambiguous'; readonly candidates: CrossSessionCandidate[] }
  | { readonly kind: 'missing' }

function candidateOf(summary: CrossSessionSummary): CrossSessionCandidate {
  return {
    sessionId: summary.sessionId,
    name: sessionDisplayName(summary),
    hint: fallbackSessionName(summary.cwd, summary.updatedAt),
  }
}

/** Most-recently-active first, running sessions ahead of idle ones. */
function orderCandidates(rows: readonly CrossSessionSummary[]): readonly CrossSessionSummary[] {
  return [...rows].sort((a, b) => {
    if (a.running !== b.running) return a.running ? -1 : 1
    return b.updatedAt - a.updatedAt
  })
}

/** Partial candidates are capped: a broad needle must stay a readable list. */
const PARTIAL_CANDIDATE_LIMIT = 10

/**
 * Resolve a user/model-supplied target reference against the session list.
 * Ladder, in order: exact sessionId → exact display name → partial natural
 * name (substring of the display name OR of the workspace cwd, case-insensitive)
 * → missing. One hit resolves outright; several hits become candidates —
 * this function NEVER guesses. Partial candidates are ordered most-recently-
 * active first (running sessions first) and capped, so "ask the 极简遥控器
 * session" works without anyone digging session ids out of log directories.
 * @param sessions - rows from `sessionController.list()`.
 * @param reference - a session id, display name, or natural partial name.
 * @returns the unique target, the candidate list, or "missing".
 */
export function matchTargetSession(
  sessions: readonly CrossSessionSummary[],
  reference: string,
): TargetMatch {
  const needle = reference.trim()
  if (needle.length === 0) return { kind: 'missing' }
  const byId = sessions.find((session) => session.sessionId === needle)
  if (byId) return { kind: 'unique', target: { sessionId: byId.sessionId, name: sessionDisplayName(byId) } }
  const folded = needle.toLowerCase()
  const exact = sessions.filter((session) => sessionDisplayName(session).toLowerCase() === folded)
  if (exact.length === 1) {
    return { kind: 'unique', target: { sessionId: exact[0].sessionId, name: sessionDisplayName(exact[0]) } }
  }
  if (exact.length > 1) {
    return { kind: 'ambiguous', candidates: orderCandidates(exact).map(candidateOf) }
  }
  const partial = sessions.filter(
    (session) =>
      sessionDisplayName(session).toLowerCase().includes(folded) ||
      (session.cwd !== undefined && session.cwd.toLowerCase().includes(folded)),
  )
  if (partial.length === 1) {
    return { kind: 'unique', target: { sessionId: partial[0].sessionId, name: sessionDisplayName(partial[0]) } }
  }
  if (partial.length === 0) return { kind: 'missing' }
  return {
    kind: 'ambiguous',
    candidates: orderCandidates(partial).slice(0, PARTIAL_CANDIDATE_LIMIT).map(candidateOf),
  }
}

/**
 * Hop guard counter: the hop of the question this session is about to send.
 * The value is carried by the asking message that reached this session, so it
 * is read from the most recent inbound `user/message` whose source is
 * `session-ask`; a later plain human prompt does not reset it, because the
 * question being asked here still descends from that relay. No session-ask
 * source anywhere means this is a fresh, top-level question (hop 0).
 * @param events - this session's log events in order.
 * @returns the hop to stamp on the outgoing message.
 */
export function nextAskHop(events: readonly CrossSessionLogEvent[]): number {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event.type !== 'user/message') continue
    const data = event.data as unknown as { readonly message?: { readonly source?: unknown } }
    const source = data.message?.source as { readonly kind?: unknown; readonly hop?: unknown } | undefined
    if (source?.kind !== 'session-ask') continue
    return typeof source.hop === 'number' && Number.isFinite(source.hop) ? source.hop + 1 : 1
  }
  return 0
}

/**
 * Collect what the target session said inside the interval. Only
 * `assistant/message` events strictly after the delivery watermark count, so a
 * reply that predates the delivery cannot be reported as an answer. The
 * watermark (highest seq already present at delivery) is the authoritative cut;
 * `fromMs` is kept only as the recorded interval start.
 * @param events - the target session's log events in order.
 * @param fromSeq - highest event seq already present at delivery time.
 * @returns the newest event time seen and the per-message text pieces.
 */
export function collectAnswer(
  events: readonly CrossSessionLogEvent[],
  fromSeq: number,
): { readonly latestEventTime: number | null; readonly pieces: string[] } {
  const pieces: string[] = []
  let latestEventTime: number | null = null
  for (const event of events) {
    if (Number.isFinite(event.time) && (latestEventTime === null || event.time > latestEventTime)) {
      latestEventTime = event.time
    }
    if (event.type !== 'assistant/message') continue
    if (!(event.seq > fromSeq)) continue
    const text = (event.data?.message?.content ?? [])
      .filter((block): block is ContentBlock & { readonly type: 'text'; readonly text: string } =>
        block.type === 'text' && typeof (block as { readonly text?: unknown }).text === 'string',
      )
      .map((block) => block.text)
      .join('')
      .trim()
    if (text.length > 0) pieces.push(text)
  }
  return { latestEventTime, pieces }
}

/** Join the interval's text pieces into the returned answer body. */
export function joinAnswerPieces(pieces: readonly string[]): string {
  return pieces.join('\n\n')
}

/** Highest event seq present, or -1 for an empty log (the session-cursor convention). */
export function logWatermark(events: readonly CrossSessionLogEvent[]): number {
  let highest = -1
  for (const event of events) {
    if (typeof event.seq === 'number' && event.seq > highest) highest = event.seq
  }
  return highest
}

/** Human-readable text the main model reads for one settled ask_session call. */
export function renderAskResult(value: {
  readonly answer: string
  readonly note: string
}): ContentBlock[] {
  const body = value.answer.trim().length > 0 ? value.answer : '（该区间内对方没有产出正文。）'
  return [{ type: 'text', text: `${body}\n\n${value.note}` }]
}

/**
 * The Host hard-excludes subagent sessions with `session/agent-busy` and the
 * reason "use subagent delivery for this child session"; recognise it so the
 * caller gets the actionable `subagent-target` code instead of `delivery-failed`.
 */
export function isSubagentDeliveryRejection(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const shape = error as { readonly code?: unknown; readonly details?: unknown; readonly message?: unknown }
  const reason =
    shape.details !== null && typeof shape.details === 'object'
      ? (shape.details as { readonly reason?: unknown }).reason
      : undefined
  const haystack = `${typeof reason === 'string' ? reason : ''} ${typeof shape.message === 'string' ? shape.message : ''}`
  return haystack.includes('subagent delivery') || haystack.includes('owned by subagent routing')
}

// ---------------------------------------------------------------------------
// Side effects: the only part that touches host services
// ---------------------------------------------------------------------------

/** One unsettled wait per session: at most one ask_session may be in flight. */
const pendingWaits = new Set<TargetSessionId>()

/** Test seam: drop every tracked wait. */
export function resetPendingWaits(): void {
  pendingWaits.clear()
}

/** Whether this session already has an unsettled ask_session wait. */
export function isWaiting(sessionId: TargetSessionId): boolean {
  return pendingWaits.has(sessionId)
}

let askCounter = 0

/** Process-unique ask id (the receiver side may dedupe on it). */
export function nextAskId(): string {
  askCounter += 1
  return `ask-${Date.now().toString(36)}-${askCounter}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Lazy host-service access: never a hard `inject` (older hosts lack this service).
 *
 * A bare `ctx.sessionController` read is gated by the plugin's `inject` list and
 * throws `cannot get property "sessionController" without inject` when the key is
 * not declared — so the property read itself must not be used. `ctx.get(name)` is
 * Cordis's documented read "without the inject requirement": it returns the service
 * or `undefined` when (not yet) provided.
 */
export function getSessionController(ctx: unknown): CrossSessionController | undefined {
  if (ctx === null || ctx === undefined) return undefined
  try {
    const context = ctx as {
      get?: (name: string, strict?: boolean) => unknown
      readonly sessionController?: unknown
    }
    const controller =
      typeof context.get === 'function'
        ? context.get.call(ctx, 'sessionController')
        : context.sessionController
    if (controller === null || typeof controller !== 'object') return undefined
    const candidate = controller as Partial<CrossSessionController>
    if (typeof candidate.list !== 'function' || typeof candidate.resolveAgent !== 'function') return undefined
    return candidate as CrossSessionController
  } catch {
    return undefined
  }
}

/** Read a live Agent's own log through a defensive view (the log API is read-only here). */
function agentEvents(agent: CrossSessionAgent): readonly CrossSessionLogEvent[] {
  try {
    return agent.session?.snapshotEvents() ?? []
  } catch {
    return []
  }
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

/** Delivery receipt: what the target looked like the moment we handed the question over. */
export interface CrossSessionDeliveryReceipt {
  readonly delivered: CrossSessionDelivery
  readonly note: string
  readonly fromSeq: number
  readonly fromMs: number
  readonly targetWasRunning: boolean
}

/**
 * Hand the question to the target session.
 *
 * Preferred path: `resolveAgent` + `agent.followup(...)`, which preserves our
 * own source kind. Fallback: `sessionController.prompt(...)`, which the Host
 * stamps as a user prompt — the envelope still names us, and the caller is told
 * in `note` that this identity-dishonest path was used.
 */
export async function deliverAsk(
  controller: CrossSessionController,
  signal: AbortSignal,
  input: {
    readonly target: CrossSessionTarget
    readonly question: string
    readonly context?: string
    readonly source: SessionAskMessageSource
    readonly targetWasRunning: boolean
  },
): Promise<{ readonly ok: true; readonly receipt: CrossSessionDeliveryReceipt } | { readonly ok: false; readonly code: CrossSessionErrorCode; readonly message: string }> {
  const envelope = buildAskEnvelope(input.source.senderName, input.question, input.context)
  try {
    const resolved = await controller.resolveAgent(input.target.sessionId)
    if ('agent' in resolved && resolved.agent) {
      const agent = resolved.agent
      agent.followup(buildAskMessage(envelope, input.source))
      // The answer floor is read AFTER delivery: on a cold target the resume
      // already appended events, and anything appended before our handover must
      // never be reportable as a reply to this question.
      return {
        ok: true,
        receipt: {
          delivered: 'native',
          note: '本次投递走了首选通道（自定义来源），对方模型能看到这条消息来自另一个会话。',
          fromSeq: logWatermark(agentEvents(agent)),
          fromMs: Date.now(),
          targetWasRunning: input.targetWasRunning,
        },
      }
    }
    const reason = 'error' in resolved ? resolved.error : undefined
    if (isSubagentDeliveryRejection(reason)) {
      return {
        ok: false,
        code: 'subagent-target',
        message: `目标会话 ${input.target.sessionId} 属于子代理（subagent）会话，跨会话投递被宿主硬性排除。请改用子代理通道（subagent / send_message）。`,
      }
    }
    const detail = describeHostError(reason)
    return deliverViaPrompt(controller, signal, envelope, input, `首选通道不可用（${detail}）`)
  } catch (error) {
    if (signal.aborted) throw error
    if (isSubagentDeliveryRejection(error)) {
      return {
        ok: false,
        code: 'subagent-target',
        message: `目标会话 ${input.target.sessionId} 属于子代理（subagent）会话，跨会话投递被宿主硬性排除。请改用子代理通道（subagent / send_message）。`,
      }
    }
    if (isTargetNotFound(error)) {
      return {
        ok: false,
        code: 'target-not-found',
        message: `找不到会话 ${input.target.sessionId}（宿主报告 session/not-found）。`,
      }
    }
    return deliverViaPrompt(controller, signal, envelope, input, `首选通道报错（${describeHostError(error)}）`)
  }
}

async function deliverViaPrompt(
  controller: CrossSessionController,
  _signal: AbortSignal,
  envelope: ContentBlock[],
  input: {
    readonly target: CrossSessionTarget
    readonly source: SessionAskMessageSource
    readonly targetWasRunning: boolean
  },
  why: string,
): Promise<{ readonly ok: true; readonly receipt: CrossSessionDeliveryReceipt } | { readonly ok: false; readonly code: CrossSessionErrorCode; readonly message: string }> {
  try {
    await controller.prompt({
      requestId: input.source.askId,
      sessionId: input.target.sessionId,
      mode: 'queue',
      content: envelope,
    })
    // Watermark as late as possible: `prompt` resumes the target, so its log may
    // gain events before we can read it, and this cut must stay after delivery.
    const floor = await watermarkViaResolve(controller, input.target.sessionId)
    return {
      ok: true,
      receipt: {
        delivered: 'fallback',
        note: `本次投递走了降级通道（宿主的 prompt 接口），宿主把来源写死成「用户输入」，对方模型会以为这是用户打的字；身份只能靠正文里的信封说明。原因：${why}`,
        fromSeq: floor,
        fromMs: Date.now(),
        targetWasRunning: input.targetWasRunning,
      },
    }
  } catch (error) {
    if (isSubagentDeliveryRejection(error)) {
      return {
        ok: false,
        code: 'subagent-target',
        message: `目标会话 ${input.target.sessionId} 属于子代理（subagent）会话，跨会话投递被宿主硬性排除。请改用子代理通道（subagent / send_message）。`,
      }
    }
    if (isTargetNotFound(error)) {
      return {
        ok: false,
        code: 'target-not-found',
        message: `找不到会话 ${input.target.sessionId}（宿主报告 session/not-found）。`,
      }
    }
    return {
      ok: false,
      code: 'delivery-failed',
      message: `投递失败：首选通道与降级通道都未能把问题送进目标会话。${why} 降级通道报错：${describeHostError(error)}`,
    }
  }
}

async function watermarkViaResolve(controller: CrossSessionController, sessionId: string): Promise<number> {
  try {
    const resolved = await controller.resolveAgent(sessionId)
    if ('agent' in resolved && resolved.agent) return logWatermark(agentEvents(resolved.agent))
  } catch {
    // Best effort only: without a watermark the timestamp filter still applies.
  }
  return -1
}

function isTargetNotFound(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  return (error as { readonly code?: unknown }).code === 'session/not-found'
}

function describeHostError(error: unknown): string {
  if (error === null || error === undefined) return '未提供原因'
  if (typeof error === 'string') return error
  if (typeof error === 'object') {
    const shape = error as { readonly code?: unknown; readonly message?: unknown }
    const code = typeof shape.code === 'string' ? shape.code : ''
    const message = typeof shape.message === 'string' ? shape.message : ''
    if (code.length > 0 || message.length > 0) return `${code}${code && message ? ' ' : ''}${message}`
    try {
      return JSON.stringify(error)
    } catch {
      return '宿主返回了无法序列化的错误'
    }
  }
  return String(error)
}

/** Result of the idle wait: why it ended and how the target looked at each poll. */
export interface CrossSessionWaitOutcome {
  readonly endedBecause: CrossSessionEndReason
  readonly lastRunning: boolean
  readonly note: string
}

/**
 * Wait for the target session's next whole-session idle after delivery.
 * Never cancels the target turn — a timeout stops only this session's waiting.
 */
export async function waitForTargetIdle(
  controller: CrossSessionController,
  signal: AbortSignal,
  input: {
    readonly sessionId: TargetSessionId
    readonly targetWasRunning: boolean
    readonly waitMs: number
    readonly log: (message: string) => void
    /** Delivery floor: new events past it prove the delivered turn already ran. */
    readonly fromSeq?: number
  },
): Promise<CrossSessionWaitOutcome> {
  const startedAt = Date.now()
  let targetRunning = input.targetWasRunning
  let observedBusy = input.targetWasRunning
  const watermark = async (): Promise<number | undefined> => {
    try {
      const resolved = await controller.resolveAgent(input.sessionId)
      if (!('agent' in resolved) || !resolved.agent) return undefined
      return logWatermark(agentEvents(resolved.agent))
    } catch {
      return undefined
    }
  }
  while (true) {
    if (signal.aborted) {
      return { endedBecause: 'error', lastRunning: targetRunning, note: '本次调用被取消，等待中止；没有取消对方的回合，对方可能仍在作答。' }
    }
    const elapsed = Date.now() - startedAt
    if (elapsed >= input.waitMs) {
      return {
        endedBecause: 'timeout',
        lastRunning: targetRunning,
        note: `等待达到上限（${input.waitMs}ms），已返回当前区间内收集到的内容；没有取消对方的回合，对方可能仍在作答。`,
      }
    }
    await sleep(Math.min(ASK_POLL_INTERVAL_MS, Math.max(0, input.waitMs - elapsed)), signal)
    let row: CrossSessionSummary | undefined
    try {
      const listed = await controller.list({}, signal)
      row = listed.items.find((item) => item.sessionId === input.sessionId)
    } catch (error) {
      if (signal.aborted) {
        return { endedBecause: 'error', lastRunning: targetRunning, note: '本次调用被取消，等待中止；没有取消对方的回合。' }
      }
      return {
        endedBecause: 'error',
        lastRunning: targetRunning,
        note: `等待期间读取会话列表失败（${describeHostError(error)}），已返回当前区间内收集到的内容。`,
      }
    }
    if (!row) continue
    if (row.running) {
      observedBusy = true
      targetRunning = true
      continue
    }
    if (observedBusy) {
      return {
        endedBecause: 'idle',
        lastRunning: false,
        note: '等待结束于该会话整体空闲（idle）。',
      }
    }
    // A turn that starts and finishes between two polls never shows `running`, so
    // polling alone would spin until the timeout even though the answer is already
    // in the log. The durable log is the authority: new events past the delivery
    // floor mean the delivered turn has run, and the session is not busy now.
    if (input.fromSeq !== undefined) {
      const now = await watermark()
      if (now !== undefined && now > input.fromSeq) {
        return {
          endedBecause: 'idle',
          lastRunning: false,
          note: '等待结束：该会话已追加新内容且当前不忙（对方的回合发生在两次轮询之间，忙的状态未被采到）。',
        }
      }
    }
    input.log(`waiting for ${input.sessionId} to start the delivered turn`)
    targetRunning = false
  }
}

/** Read the target's log back and collect what it said inside the interval. */
export async function collectTargetAnswer(
  controller: CrossSessionController,
  sessionId: TargetSessionId,
  fromSeq: number,
): Promise<{ readonly pieces: string[]; readonly readError?: string }> {
  try {
    const resolved = await controller.resolveAgent(sessionId)
    if (!('agent' in resolved) || !resolved.agent) {
      return { pieces: [], readError: describeHostError('error' in resolved ? resolved.error : undefined) }
    }
    const collected = collectAnswer(agentEvents(resolved.agent), fromSeq)
    return { pieces: collected.pieces }
  } catch (error) {
    return { pieces: [], readError: describeHostError(error) }
  }
}

/** Fixed guard values for one call; separated so tests can drive them directly. */
export interface AskSessionGuards {
  readonly currentSessionId: TargetSessionId
  readonly hop: number
}

/** Concrete reason one ask is refused before delivery. */
export interface AskSessionRejection {
  readonly code: CrossSessionErrorCode
  readonly message: string
  readonly candidates?: readonly CrossSessionCandidate[]
}

/**
 * Every pre-delivery guard, in one place. Pure: takes plain facts, returns a
 * rejection or nothing. Order matters — identity before ownership, ownership
 * before budget, budget before hop.
 * @returns the rejection, or undefined when the ask may proceed.
 */
export function checkAskGuards(input: {
  readonly guards: AskSessionGuards
  readonly match: TargetMatch
  readonly sessions: readonly CrossSessionSummary[]
  readonly question: string
  readonly context?: string
  readonly target?: CrossSessionTarget
}): AskSessionRejection | undefined {
  const { guards, match } = input
  if (match.kind === 'missing') {
    return {
      code: 'target-not-found',
      message: '没有找到匹配的会话。请用会话列表里的标题或 sessionId 指定目标；不确认时先列出候选再让用户选择。',
    }
  }
  if (match.kind === 'ambiguous') {
    return {
      code: 'target-ambiguous',
      message: `有 ${match.candidates.length} 个会话都叫这个名字，不能猜。请把候选交给用户挑选（用 sessionId 指定即可精确命中）。`,
      candidates: match.candidates,
    }
  }
  const target = input.target ?? match.target
  if (target.sessionId === guards.currentSessionId) {
    return { code: 'self-target', message: '目标是当前会话自己，拒绝自问自答。' }
  }
  const row = input.sessions.find((session) => session.sessionId === target.sessionId)
  if (row?.origin === 'subagent') {
    return {
      code: 'subagent-target',
      message: '目标会话是子代理（subagent）会话，跨会话投递被宿主硬性排除。请改用子代理通道（subagent / send_message）。',
    }
  }
  const bytes = askContentBytes(input.question, input.context)
  if (bytes > ASK_CONTENT_MAX_BYTES) {
    return {
      code: 'content-too-large',
      message: `问题加背景共 ${bytes} 字节，超过上限 ${ASK_CONTENT_MAX_BYTES} 字节。请缩短问题，或把背景留在自己的会话里分次提问。`,
    }
  }
  if (guards.hop > ASK_HOP_LIMIT) {
    return {
      code: 'hop-limit',
      message: `本次提问会形成第 ${guards.hop} 跳转发（上限 ${ASK_HOP_LIMIT + 1} 跳：0→${ASK_HOP_LIMIT}）。会话链式互问会绕成环，已拒绝；请由用户直接指定目标会话，或让当前会话自己作答。`,
    }
  }
  return undefined
}

/** Validated, side-effect-free plan for one ask_session call. */
export interface AskSessionPlan {
  readonly target: CrossSessionTarget
  readonly senderName: string
  readonly hop: number
  readonly question: string
  readonly context?: string
}

/** Normalise and validate the model-supplied wait budget. */
export function normalizeWaitMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return ASK_WAIT_DEFAULT_MS
  return Math.min(Math.floor(value), ASK_WAIT_MAX_MS)
}

/**
 * Full v0 orchestration: guard, deliver, wait for the target's next idle, then
 * return what the target said inside the interval.
 *
 * @param ctx - plugin context carrying `sessionController` on newer hosts.
 * @param signal - the tool call's cancellation.
 * @param input - the validated tool arguments plus the caller's session facts.
 * @returns the tool value, in the shape `ask_session` declares.
 */
/**
 * Card hook payload: delivery was accepted — the UI opens the cross-session
 * ask card in its waiting state. Callbacks are UI-only side effects: they
 * must not throw (a failure must never break the ask itself).
 */
export interface AskCardDelivery {
  readonly askId: string
  readonly question: string
  readonly context?: string
  readonly senderName: string
  readonly targetName: string
}

/**
 * Card hook payload: the wait settled (answer collected, timeout, or an
 * interruption after delivery) — the UI closes the card with answer + note.
 */
export interface AskCardSettle {
  readonly askId: string
  readonly question: string
  readonly targetName: string
  readonly answer: string
  readonly note: string
}

export async function askSession(
  ctx: unknown,
  signal: AbortSignal,
  input: {
    readonly currentSessionId: TargetSessionId
    readonly senderName: string
    readonly currentEvents: readonly CrossSessionLogEvent[]
    readonly target?: string
    readonly question: string
    readonly context?: string
    readonly waitMs?: number
    readonly log?: (message: string) => void
    /** UI hook: delivery accepted → open the ask card. Must not throw. */
    readonly onDelivered?: (info: AskCardDelivery) => void
    /** UI hook: wait settled → close the ask card. Must not throw. */
    readonly onSettled?: (info: AskCardSettle) => void
  },
): Promise<Record<string, unknown>> {
  const controller = getSessionController(ctx)
  if (!controller) {
    return {
      ok: false,
      error: 'service-missing',
      message: '此功能需要较新的 DSH 宿主：当前宿主没有提供 sessionController 服务，无法向其他会话投递问题。',
    }
  }

  const waitMs = normalizeWaitMs(input.waitMs)
  if (typeof input.waitMs === 'number' && input.waitMs > ASK_WAIT_MAX_MS) {
    (input.log ?? (() => {}))(`ask_session waitMs 超出上限，已按 ${waitMs}ms 处理`)
  }
  if (isWaiting(input.currentSessionId)) {
    return toToolError({
      code: 'already-waiting',
      message: '当前会话已经在等另一个会话的答复（同一时刻只允许等一个），请等这次返回后再发起新的提问。',
    })
  }
  // Latch BEFORE the first await: two tool calls dispatched in the same step
  // would otherwise both pass the check above and both start waiting.
  pendingWaits.add(input.currentSessionId)
  try {
    const sessions: CrossSessionSummary[] = []
    let match: TargetMatch = { kind: 'missing' }
    try {
      const listed = await controller.list({}, signal)
      sessions.push(...listed.items)
      match = matchTargetSession(sessions, input.target ?? '')
    } catch (error) {
      return {
        ok: false,
        error: 'service-missing',
        message: `读取会话列表失败：${describeHostError(error)}`,
      }
    }
    return await runAsk(ctx, controller, signal, input, {
      sessions,
      match,
      log: input.log ?? (() => {}),
    })
  } finally {
    pendingWaits.delete(input.currentSessionId)
  }
}

/**
 * The ask itself, after the target list has been read and the wait latch is
 * held by the caller.
 */
async function runAsk(
  ctx: unknown,
  controller: CrossSessionController,
  signal: AbortSignal,
  input: {
    readonly currentSessionId: TargetSessionId
    readonly senderName: string
    readonly currentEvents: readonly CrossSessionLogEvent[]
    readonly question: string
    readonly context?: string
    readonly waitMs?: number
    readonly onDelivered?: (info: AskCardDelivery) => void
    readonly onSettled?: (info: AskCardSettle) => void
  },
  listed: {
    readonly sessions: readonly CrossSessionSummary[]
    readonly match: TargetMatch
    readonly log: (message: string) => void
  },
): Promise<Record<string, unknown>> {
  const waitMs = normalizeWaitMs(input.waitMs)
  const hop = nextAskHop(input.currentEvents)
  const rejectionBase = checkAskGuards({
    guards: { currentSessionId: input.currentSessionId, hop },
    match: listed.match,
    sessions: listed.sessions,
    question: input.question,
    context: input.context,
  })
  if (rejectionBase) return toToolError(rejectionBase)

  const target = listed.match.kind === 'unique' ? listed.match.target : { sessionId: '', name: '' }
  const targetRow = listed.sessions.find((session) => session.sessionId === target.sessionId)
  const askId = nextAskId()
  const source: SessionAskMessageSource = {
    kind: 'session-ask',
    form: 'relay',
    askId,
    senderSessionId: input.currentSessionId,
    senderName: input.senderName,
    hop,
  }

  const from = new Date().toISOString()
  const delivery = await deliverAsk(controller, signal, {
    target,
    question: input.question,
    context: input.context,
    source,
    targetWasRunning: targetRow?.running === true,
  })
  if (!delivery.ok) {
    return { ok: false, error: delivery.code, message: delivery.message }
  }
  // Delivery accepted: the card opens NOW so the user sees the waiting state
  // for the whole wait window (up to waitMs), not only after it settles.
  input.onDelivered?.({
    askId,
    question: input.question,
    ...(input.context === undefined ? {} : { context: input.context }),
    senderName: input.senderName,
    targetName: target.name,
  })
  // The whole wait/collect chain below is internally guarded (sleep resolves
  // on abort, list/watermark/collect convert failures into outcome notes), so
  // every path — idle, timeout, cancelled, host error — falls through to the
  // settle call; the card can never be left open by a throwing wait.
  const outcome = await waitForTargetIdle(controller, signal, {
    sessionId: target.sessionId,
    targetWasRunning: delivery.receipt.targetWasRunning,
    waitMs,
    log: listed.log,
    fromSeq: delivery.receipt.fromSeq,
  })
  const collected = await collectTargetAnswer(
    controller,
    target.sessionId,
    delivery.receipt.fromSeq,
  )
  const answer = joinAnswerPieces(collected.pieces)
  const to = outcome.endedBecause === 'idle' ? new Date().toISOString() : null
  const notes = [
    '区间语义：从投递回执到对方会话下一次整体空闲，这两个时刻之间对方产出的文字都算在内——这是「这个区间里对方说的话」，不是逐条对应的回答。',
    delivery.receipt.note,
    outcome.note,
    delivery.receipt.targetWasRunning
      ? '投递时对方正在忙，问题已排队，会在它当前回合结束后进入新回合。'
      : '投递时对方不忙，宿主已唤醒它开一个新回合。',
    collected.readError === undefined ? '' : `读取对方会话日志时出错，answer 可能不完整：${collected.readError}`,
  ].filter((line) => line.length > 0)
  const note = notes.join('\n')
  // Settle the card BEFORE returning so the closed state is in the log by
  // the time the tool result reaches the model.
  input.onSettled?.({
    askId,
    question: input.question,
    targetName: target.name,
    answer,
    note,
  })
  return {
    ok: true,
    target: { sessionId: target.sessionId, name: target.name },
    delivered: delivery.receipt.delivered,
    askId,
    interval: { from, to, endedBecause: outcome.endedBecause },
    answer,
    note,
  }
}

function toToolError(rejection: AskSessionRejection): Record<string, unknown> {
  return {
    ok: false,
    error: rejection.code,
    message: rejection.message,
    ...(rejection.candidates ? { candidates: rejection.candidates } : {}),
  }
}
