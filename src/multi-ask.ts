/**
 * Batch cross-session ask (`ask_sessions`): one question to 1–8 targets in one
 * call, with every result collected into one summary. Each target gets its own
 * delivery, its own wait and its own AskRecord, so `ask_result <askId>` keeps
 * working afterwards and `parentAskId` is filled the same way `ask_session`
 * fills it.
 *
 * This module owns no delivery or collection logic: it reuses
 * {@link deliverAsk} for the handover and {@link collectDeliveredAsk} for the
 * wait/collect half, plus {@link matchTargetSession} / {@link checkAskGuards}
 * for resolution and the per-target guards. There is no routing here: an
 * unnamed or ambiguous target is skipped with a reason, never guessed.
 */
import { writeAskRecord, type AskRecord } from './ask-store'
import {
  allowedAskSessions,
  askStoreRoot,
  checkAskGuards,
  collectDeliveredAsk,
  deliverAsk,
  getSessionController,
  inboundAskId,
  matchTargetSession,
  nextAskHop,
  nextAskId,
  normalizeWaitMs,
  sessionDisplayName,
  trackBackgroundController,
  type AskSessionRejection,
  type CrossSessionController,
  type CrossSessionLogEvent,
  type CrossSessionSummary,
  type CrossSessionTarget,
  type SessionAskMessageSource,
} from './cross-session'

/** How a batch waits: `all` = every target, `any` = first settled target. */
export type BatchAskMode = 'all' | 'any'

/** One settled (or failed) target of a batch. */
export interface BatchAskResult {
  sessionId: string
  name: string
  askId: string
  state: 'done' | 'timeout' | 'error'
  answer: string
  status?: 'ok' | 'partial' | 'failed'
  note?: string
  error?: string
}

/** One target that never got a question, with the reason why. */
export interface BatchAskSkip {
  target: string
  reason: string
}

export interface AskSessionsInput {
  readonly currentSessionId: string
  readonly currentEvents: readonly CrossSessionLogEvent[]
  readonly targets: readonly string[]
  readonly question: string
  readonly context?: string
  readonly mode?: BatchAskMode
  /** Per-target ceiling; defaults to `defaultWaitMs`, clamped by normalizeWaitMs. */
  readonly waitMs?: number
  /** `swarm.defaultWaitMs`, used when `waitMs` is omitted. */
  readonly defaultWaitMs: number
  /** `swarm.routingExclude`: excluded sessions are skipped, never asked. */
  readonly exclude?: readonly string[]
  /** `swarm.enabled`: when false every target is skipped. */
  readonly swarmEnabled: boolean
  readonly log?: (message: string) => void
}

/** Schema cap for one batch; extra targets are dropped (the schema says 1–8). */
const BATCH_MAX_TARGETS = 8

const BATCH_SWARM_DISABLED = '蜂群模式已在设置里关闭（设置 → 插件 → 顾问群 → 全局蜂群）。'

/** Concise per-target reason for a guard rejection (ask_session wording is long). */
function skipReasonFor(rejection: AskSessionRejection): string {
  switch (rejection.code) {
    case 'self-target':
      return '目标是当前会话自己'
    case 'subagent-target':
      return '目标会话是子代理（subagent）会话'
    case 'hop-limit':
      return '本次提问会超过 2 跳转发上限'
    default:
      return rejection.message
  }
}

/** One child signal that aborts with its parent and on plugin dispose. */
function linkedSignal(parent: AbortSignal): { readonly signal: AbortSignal; readonly dispose: () => void } {
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  if (parent.aborted) controller.abort()
  else parent.addEventListener('abort', onAbort, { once: true })
  // Plugin dispose cancels every in-flight target through cancelDetachedAsks().
  const untrack = trackBackgroundController(controller)
  return {
    signal: controller.signal,
    dispose: () => {
      parent.removeEventListener('abort', onAbort)
      untrack()
    },
  }
}

/** One resolved, guard-approved delivery. */
interface DeliveryPlan {
  readonly target: CrossSessionTarget
  readonly targetWasRunning: boolean
}

/** Shared facts for every target task of one batch. */
interface BatchContext {
  readonly controller: CrossSessionController
  readonly currentSessionId: string
  readonly senderName: string
  readonly question: string
  readonly context?: string
  readonly hop: number
  readonly parentAskId?: string
  readonly waitMs: number
  readonly storeDir: string
  readonly log: (message: string) => void
  readonly parentSignal: AbortSignal
}

/**
 * Deliver to one target, write its waiting record, then wait/collect and write
 * the settled record. Never throws: a failure becomes an `error` result (and,
 * once delivered, an `error` record so `ask_result` still reports it).
 */
async function askOne(plan: DeliveryPlan, batch: BatchContext): Promise<BatchAskResult> {
  const askId = nextAskId()
  const from = new Date().toISOString()
  const linked = linkedSignal(batch.parentSignal)
  let record: AskRecord | undefined
  try {
    const source: SessionAskMessageSource = {
      kind: 'session-ask',
      form: 'relay',
      askId,
      senderSessionId: batch.currentSessionId,
      senderName: batch.senderName,
      hop: batch.hop,
    }
    const delivery = await deliverAsk(batch.controller, linked.signal, {
      target: plan.target,
      question: batch.question,
      context: batch.context,
      source,
      targetWasRunning: plan.targetWasRunning,
    })
    if (!delivery.ok) {
      return {
        sessionId: plan.target.sessionId,
        name: plan.target.name,
        askId,
        state: 'error',
        answer: '',
        error: `${delivery.code}: ${delivery.message}`,
      }
    }
    const waitingRecord: AskRecord = {
      askId,
      sessionId: batch.currentSessionId,
      targetSessionId: plan.target.sessionId,
      targetName: plan.target.name,
      question: batch.question,
      state: 'waiting',
      createdAt: Date.now(),
      from,
      ...(batch.parentAskId === undefined ? {} : { parentAskId: batch.parentAskId }),
    }
    record = waitingRecord
    try {
      writeAskRecord(batch.storeDir, waitingRecord)
    } catch (error) {
      console.warn('[dsh-advisor-group] 批量提问记录落盘失败（投递仍已发出）：', error)
    }
    const collected = await collectDeliveredAsk(batch.controller, linked.signal, {
      target: plan.target,
      waitMs: batch.waitMs,
      from,
      targetWasRunning: delivery.receipt.targetWasRunning,
      fromSeq: delivery.receipt.fromSeq,
      deliveryNote: delivery.receipt.note,
      log: batch.log,
    })
    const state: BatchAskResult['state'] =
      collected.interval.endedBecause === 'idle'
        ? 'done'
        : collected.interval.endedBecause === 'timeout'
          ? 'timeout'
          : 'error'
    try {
      writeAskRecord(batch.storeDir, {
        ...waitingRecord,
        state,
        answer: collected.rawAnswer,
        ...(collected.reply === undefined ? {} : { reply: collected.reply }),
        status: collected.status,
        note: collected.note,
        settledAt: Date.now(),
      })
    } catch (error) {
      console.warn('[dsh-advisor-group] 批量提问记录落盘失败：', error)
    }
    return {
      sessionId: plan.target.sessionId,
      name: plan.target.name,
      askId,
      state,
      answer: collected.answer,
      status: collected.status,
      note: collected.note,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (record !== undefined) {
      try {
        writeAskRecord(batch.storeDir, { ...record, state: 'error', error: message, settledAt: Date.now() })
      } catch {
        // Best effort: a failed record write must not break the batch.
      }
    }
    return {
      sessionId: plan.target.sessionId,
      name: plan.target.name,
      askId,
      state: 'error',
      answer: '',
      error: message,
    }
  } finally {
    linked.dispose()
  }
}

/** `targets` → trimmed, de-duplicated (exact spelling), capped at the schema limit. */
function readTargets(targets: unknown): string[] {
  const values = Array.isArray(targets) ? targets : []
  const seen = new Set<string>()
  const picked: string[] = []
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    picked.push(trimmed)
    if (picked.length >= BATCH_MAX_TARGETS) break
  }
  return picked
}

/** All-skipped answer: `ok: false` with the reasons, never an exception. */
function skippedOnly(skipped: BatchAskSkip[]): AskSessionsReply {
  return { ok: false, count: 0, results: [], skipped }
}

/** The tool value of one batch: exactly the shape `ask_sessions` declares. */
export interface AskSessionsReply {
  ok: boolean
  count: number
  results: BatchAskResult[]
  skipped: BatchAskSkip[]
}

/**
 * Run one batch ask: resolve targets, apply every per-target guard, deliver
 * concurrently and collect the results.
 *
 * - `all`: wait for every target to settle (or its own ceiling).
 * - `any`: return the first settled target; the others keep running in the
 *   background and still write their own settled AskRecords.
 *
 * Never guesses: unnamed, ambiguous, missing, excluded or guard-rejected
 * targets land in `skipped`. When every target is skipped the call reports
 * `ok: false` with those reasons instead of failing with an exception.
 */
export async function askSessions(
  ctx: unknown,
  signal: AbortSignal,
  input: AskSessionsInput,
): Promise<AskSessionsReply> {
  const mode: BatchAskMode = input.mode === 'any' ? 'any' : 'all'
  const waitMs = normalizeWaitMs(typeof input.waitMs === 'number' ? input.waitMs : input.defaultWaitMs)
  const log = input.log ?? (() => {})
  const targets = readTargets(input.targets)
  const skipped: BatchAskSkip[] = []

  if (targets.length === 0) return skippedOnly(skipped)
  if (!input.swarmEnabled) {
    for (const target of targets) skipped.push({ target, reason: BATCH_SWARM_DISABLED })
    return skippedOnly(skipped)
  }
  if (typeof input.question !== 'string' || input.question.trim().length === 0) {
    for (const target of targets) skipped.push({ target, reason: '缺少问题' })
    return skippedOnly(skipped)
  }
  const controller = getSessionController(ctx)
  if (controller === undefined) {
    for (const target of targets) skipped.push({ target, reason: '宿主没有提供 sessionController' })
    return skippedOnly(skipped)
  }
  if (typeof input.currentSessionId !== 'string' || input.currentSessionId.length === 0) {
    for (const target of targets) skipped.push({ target, reason: '无法确定当前会话的身份' })
    return skippedOnly(skipped)
  }

  let full: CrossSessionSummary[]
  try {
    const listed = await controller.list({}, signal)
    full = [...listed.items]
  } catch {
    for (const target of targets) skipped.push({ target, reason: '读取会话列表失败' })
    return skippedOnly(skipped)
  }
  const allowed = allowedAskSessions(full, input.exclude)
  const own = full.find((session) => session.sessionId === input.currentSessionId)
  const senderName = own === undefined ? '未命名会话' : sessionDisplayName(own)
  const hop = nextAskHop(input.currentEvents)
  const parentAskId = inboundAskId(input.currentEvents)

  const plans: DeliveryPlan[] = []
  const plannedIds = new Set<string>()
  for (const target of targets) {
    if (target.length === 0) {
      skipped.push({ target, reason: '没点名' })
      continue
    }
    const match = matchTargetSession(allowed, target)
    if (match.kind === 'ambiguous') {
      skipped.push({ target, reason: `有 ${match.candidates.length} 个同名会话` })
      continue
    }
    if (match.kind === 'missing') {
      const fullMatch = matchTargetSession(full, target)
      if (
        fullMatch.kind === 'unique' &&
        !allowed.some((session) => session.sessionId === fullMatch.target.sessionId)
      ) {
        skipped.push({ target, reason: '这个会话被设置为不参与蜂群' })
      } else if (fullMatch.kind === 'ambiguous') {
        skipped.push({ target, reason: `有 ${fullMatch.candidates.length} 个同名会话` })
      } else {
        skipped.push({ target, reason: '没有找到匹配的会话' })
      }
      continue
    }
    // A second spelling of an already-planned session collapses silently.
    if (plannedIds.has(match.target.sessionId)) continue
    const rejection = checkAskGuards({
      guards: { currentSessionId: input.currentSessionId, hop },
      match,
      sessions: allowed,
      question: input.question,
      context: input.context,
    })
    if (rejection !== undefined) {
      skipped.push({ target, reason: skipReasonFor(rejection) })
      continue
    }
    const row = allowed.find((session) => session.sessionId === match.target.sessionId)
    plannedIds.add(match.target.sessionId)
    plans.push({ target: match.target, targetWasRunning: row?.running === true })
  }

  if (plans.length === 0) return skippedOnly(skipped)
  const batch: BatchContext = {
    controller,
    currentSessionId: input.currentSessionId,
    senderName,
    question: input.question,
    context: input.context,
    hop,
    parentAskId,
    waitMs,
    storeDir: askStoreRoot(),
    log,
    parentSignal: signal,
  }
  const tasks = plans.map((plan) => askOne(plan, batch))
  // With `any` only the winner is awaited; the other tasks keep running (their
  // own records settle inside askOne) and are intentionally not awaited here.
  const results: BatchAskResult[] = mode === 'any' ? [await Promise.race(tasks)] : await Promise.all(tasks)
  return { ok: true, count: results.length, results, skipped }
}
