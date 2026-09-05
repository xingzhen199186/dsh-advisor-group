import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync, unlinkSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Session, type SessionId } from '@deepseek-ai/dsh-session'
import type { AdvisorConfig, Config } from './config'
import { callViaCtxLlm, type TranscriptEntry } from './providers/ctx-llm'
import { streamDirectHttp } from './providers/direct-http'
import { advisorJoinPrompt } from './providers/advisor-prompt'
import { generateConclusion, generateDeepenQuestion, resolveDriverSource } from './driver'
import { appendAdvisorDelta, appendAdvisorEnd, appendAdvisorMessage, appendAdvisorResume } from './session-log'
import { publish } from './stream-channel'
import { executeAdvisorTool, resolveAdvisorToolSchemas, runAdvisorToolLoop, type AdvisorAgent } from './advisor-tools'
import type { ChatMessage, ConsultSession, ConsultSummary, AdvisorSummary, TruncationInfo, PersistedSession } from './types'
import './events'

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  return error instanceof Error && error.name === 'AbortError'
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Real consult ids are server-minted uuids; anything else is rejected. */
function isSafeConsultId(id: string): boolean {
  return UUID_RE.test(id)
}

/** Agent DSH session ids look like `session-<uuid>` or a plain uuid. */
function isSafeDshSessionId(id: string): boolean {
  return UUID_RE.test(id) || UUID_RE.test(id.replace(/^session-/i, ''))
}

interface RepeatTrack {
  text: string
  count: number
}

function extractUserMessageText(event: { type: string; data?: unknown }): string | null {
  if (event.type !== 'user/message') return null
  const data = event.data as
    | { content?: Array<{ type?: string; text?: string }> }
    | undefined
  if (!data?.content) return null
  const text = data.content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join(' ')
    .trim()
  return text.length > 0 ? text : null
}

export class AdvisorGroupService {
  private sessions = new Map<string, ConsultSession>()
  private repeatTracker = new Map<string, RepeatTrack>()
  private persistEnabledCallback?: (enabled: boolean) => Promise<void>
  private dailyConsultationDate = ''
  private dailyConsultationCount = 0
  /** Durable daily-guard counter fixture under the DSH home storage area. */
  private readonly dailyGuardPath: string
  private dailyWriteChain: Promise<void> = Promise.resolve()
  /** Per-session stop controllers for the auto-deepen pipeline. */
  private readonly activeAborts = new Map<string, AbortController>()
  /** Durable consultation snapshots (usable after a dsh restart). */
  private readonly sessionsDir: string
  private sessionWriteChain: Promise<void> = Promise.resolve()
  private enabled: boolean
  private config: Config

  constructor(
    private ctx: Context,
    config: Config,
  ) {
    this.config = config
    this.enabled = config.enabled
    // Durable daily-guard state lives next to other DSH-stored fixtures so a
    // restart no longer resets the cost guard to zero (in-memory-only counters
    // were trivially bypassed by restarting the harness).
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
    this.dailyGuardPath = join(dshHome, 'storages', 'advisor-group', 'daily-guard.json')
    this.sessionsDir = join(dshHome, 'storages', 'advisor-group', 'sessions')
    this.loadDailyGuard()
    this.loadStoredSessions()
    // Track repeated user questions per session. The injected system-prompt
    // section reads this through getRepeatPressure() so the main model is told
    // to escalate when the same question has been asked repeatedly.
    ctx.on('session/event', (session: Session, event: { type: string; data?: unknown }) => {
      const text = extractUserMessageText(event)
      if (!text) return
      const tracked = this.repeatTracker.get(session.id)
      if (!tracked || tracked.text !== text) {
        this.repeatTracker.set(session.id, { text, count: 1 })
      } else {
        tracked.count += 1
      }
    })
  }

  private loadDailyGuard(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.dailyGuardPath, 'utf8')) as {
        date?: unknown
        count?: unknown
      }
      if (typeof parsed.date === 'string' && typeof parsed.count === 'number' && Number.isSafeInteger(parsed.count) && parsed.count >= 0) {
        this.dailyConsultationDate = parsed.date
        this.dailyConsultationCount = parsed.count
      }
    } catch {
      // No fixture yet (or unreadable): start from zero for the current UTC day.
    }
  }

  /** Serialized, atomic (tmp + rename) daily-guard persistence; never blocks a consultation. */
  private persistDailyGuard(): void {
    const payload = JSON.stringify({
      date: this.dailyConsultationDate,
      count: this.dailyConsultationCount,
    })
    this.dailyWriteChain = this.dailyWriteChain
      .then(async () => {
        await fsp.mkdir(dirname(this.dailyGuardPath), { recursive: true })
        const tmp = `${this.dailyGuardPath}.tmp`
        await fsp.writeFile(tmp, payload, 'utf8')
        await fsp.rename(tmp, this.dailyGuardPath)
      })
      .catch((error) => {
        // Guard state stays correct in memory; only durability is degraded.
        console.warn(
          '[dsh-advisor-group] 每日护栏持久化失败：',
          error instanceof Error ? error.message : String(error),
        )
      })
  }

  /**
   * Restore interrupted consultations from durable snapshots so the card's
   * 「▶ 继续聊天」 button still works after a dsh restart. Completed sessions
   * are not restored (they cannot resume) and their snapshot is cleaned up.
   */
  private loadStoredSessions(): void {
    let files: string[]
    try {
      files = readdirSync(this.sessionsDir).filter((name) => name.endsWith('.json'))
    } catch {
      return
    }
    for (const file of files) {
      try {
        const raw = JSON.parse(readFileSync(join(this.sessionsDir, file), 'utf8')) as PersistedSession
        if (raw.version !== 1 || typeof raw.id !== 'string' || typeof raw.question !== 'string') continue
        // Path-injection hardening: only real consult uuids are accepted as
        // session identity (the id is used for file lookup and store prepare);
        // anything else is treated as a corrupt/foreign snapshot.
        if (!isSafeConsultId(raw.id)) continue
        if (raw.dshSessionId !== undefined && !isSafeDshSessionId(raw.dshSessionId)) continue
        if (raw.status === 'completed') {
          unlinkSync(join(this.sessionsDir, file))
          continue
        }
        const advisors = this.resolveAdvisors(raw.advisorIds)
        if (advisors.length === 0) continue
        const session: ConsultSession = {
          id: raw.id,
          // Any interrupted state (stop or crash) is resumable; the card shows
          // STOPPED until resume flips it back to LIVE.
          status: 'cancelled',
          question: raw.question,
          context: raw.context,
          advisors,
          maxRounds: raw.maxRounds,
          messages: raw.messages.map((message) => ({
            role: message.role,
            advisorId: message.advisorId,
            advisorName: message.advisorName,
            content: message.content,
            thinking: message.thinking,
            round: message.round,
            truncated: message.truncated,
            ts: message.ts,
          })),
          cwd: raw.cwd,
          dshSessionId: raw.dshSessionId,
          driverSource: raw.driverSource,
          stopReason: raw.stopReason,
          createdAt: raw.createdAt,
          updatedAt: raw.updatedAt,
        }
        this.sessions.set(session.id, session)
      } catch {
        // Corrupt snapshot: skip it, the durable session log still has history.
      }
    }
  }

  /** Serialization-safe snapshot: advisor identity only, NEVER credentials. */
  private snapshotPayload(session: ConsultSession): PersistedSession {
    return {
      version: 1,
      id: session.id,
      status: session.status,
      question: session.question,
      ...(session.context === undefined ? {} : { context: session.context }),
      ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
      ...(session.dshSessionId === undefined ? {} : { dshSessionId: session.dshSessionId }),
      ...(session.driverSource === undefined ? {} : { driverSource: session.driverSource }),
      ...(session.stopReason === undefined ? {} : { stopReason: session.stopReason }),
      advisorIds: session.advisors.map((advisor) => advisor.id),
      maxRounds: session.maxRounds,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messages: session.messages.map((message) => ({
        role: message.role,
        ...(message.advisorId === undefined ? {} : { advisorId: message.advisorId }),
        ...(message.advisorName === undefined ? {} : { advisorName: message.advisorName }),
        content: message.content,
        ...(message.thinking === undefined ? {} : { thinking: message.thinking }),
        ...(message.round === undefined ? {} : { round: message.round }),
        ...(message.truncated === undefined ? {} : { truncated: message.truncated }),
        ts: message.ts,
      })),
    }
  }

  /** Serialized, atomic (tmp + rename) consultation snapshot persistence. */
  private persistSession(session: ConsultSession): void {
    // Defense-in-depth: never write outside the sessions dir (the id is a
    // server-minted uuid, but a corrupted in-memory session must not escape).
    if (!isSafeConsultId(session.id)) {
      console.warn('[dsh-advisor-group] 拒绝持久化非法会话 id：', session.id)
      return
    }
    const payload = JSON.stringify(this.snapshotPayload(session))
    const target = join(this.sessionsDir, `${session.id}.json`)
    this.sessionWriteChain = this.sessionWriteChain
      .then(async () => {
        await fsp.mkdir(this.sessionsDir, { recursive: true })
        const tmp = `${target}.tmp`
        await fsp.writeFile(tmp, payload, 'utf8')
        await fsp.rename(tmp, target)
      })
      .catch((error) => {
        console.warn(
          '[dsh-advisor-group] 咨询快照持久化失败：',
          error instanceof Error ? error.message : String(error),
        )
      })
  }

  /** Structural view of the DSH in-memory session store (may be absent). */
  private get sessionStore(): {
    get(id: string): Session | undefined
    prepare(id: string, options: unknown): Session
    enter(session: Session): () => void
    flush(session: Session): Promise<boolean>
  } | undefined {
    // Cordis's context proxy throws on keys that were not declared in `inject`
    // ("cannot get property ... without inject"). The service must keep working
    // (SSE + snapshot only) when the store is unavailable, so probe guarded.
    let store: unknown
    try {
      store = (this.ctx as unknown as { sessions?: unknown }).sessions
    } catch {
      return undefined
    }
    if (!store || typeof store !== 'object') return undefined
    const typed = store as {
      get?: unknown
      prepare?: unknown
      enter?: unknown
      flush?: unknown
    }
    if (
      typeof typed.get !== 'function' ||
      typeof typed.prepare !== 'function' ||
      typeof typed.enter !== 'function' ||
      typeof typed.flush !== 'function'
    ) {
      return undefined
    }
    return store as {
      get(id: string): Session | undefined
      prepare(id: string, options: unknown): Session
      enter(session: Session): () => void
      flush(session: Session): Promise<boolean>
    }
  }

  /** Best-effort durability barrier for the advisor-group log events. */
  private async flushLog(sessionLog?: Session): Promise<void> {
    if (!sessionLog) return
    const store = this.sessionStore
    if (!store) return
    try {
      await store.flush(sessionLog)
    } catch {
      // Best effort: the snapshot already covers resumability.
    }
  }

  /** Build a contiguous seed log from the snapshot (cross-restart resume). */
  private buildSeedEvents(session: ConsultSession): Array<{ type: string; seq: number; time: number; data: Record<string, unknown> }> {
    const events: Array<{ type: string; seq: number; time: number; data: Record<string, unknown> }> = []
    let seq = 0
    events.push({
      type: 'advisor-group/start',
      seq: seq++,
      time: session.createdAt,
      data: {
        sessionId: session.id,
        turn: 0,
        step: 0,
        question: session.question,
        ...(session.context === undefined ? {} : { context: session.context }),
        advisors: session.advisors.map(({ id, name, avatar }) => (avatar === undefined ? { id, name } : { id, name, avatar })),
      },
    })
    for (const message of session.messages) {
      if (message.role === 'system') continue
      events.push({
        type: 'advisor-group/message',
        seq: seq++,
        time: message.ts || Date.now(),
        data: {
          sessionId: session.id,
          turn: 0,
          step: 0,
          role: message.role,
          content: message.content,
          ...(message.advisorId === undefined ? {} : { advisorId: message.advisorId }),
          ...(message.advisorName === undefined ? {} : { advisorName: message.advisorName }),
          ...(message.thinking === undefined ? {} : { thinking: message.thinking }),
          ...(message.round === undefined ? {} : { round: message.round }),
          ...(message.truncated === undefined ? {} : { truncated: message.truncated }),
        },
      })
    }
    return events
  }

  /**
   * Obtain the DSH Session handle for durable log events. Prefers the live
   * store entry (same process). After a restart the store is empty, so the
   * session is rebuilt with `prepare` + `enter` (append hooks publish events
   * and the persistence layer picks them up; the session is NOT announced, so
   * no agent lifecycle reactivation is triggered). Falls back to a detached
   * `Session.create` (live SSE + snapshot only, no durable log) when neither
   * works.
   */
  private resolveSessionHandle(session: ConsultSession): Session | undefined {
    const store = this.sessionStore
    // Rebuild under the AGENT's DSH session id (not the consult id): the card
    // is assembled from the agent session log, so resume events must land in
    // THAT session to be visible. Falls back to the consult id when the agent
    // session id was never recorded. Both are whitelisted (uuid-shaped) so a
    // tampered snapshot cannot name an arbitrary store key.
    const resumeId =
      session.dshSessionId !== undefined && isSafeDshSessionId(session.dshSessionId)
        ? session.dshSessionId
        : isSafeConsultId(session.id)
          ? session.id
          : ''
    if (!resumeId) return undefined
    const live = store?.get(resumeId)
    if (live) return live
    if (!store) {
      return this.buildDetachedSession(session, resumeId)
    }
    try {
      // cwd from the snapshot is untrusted: only absolute paths are honored,
      // anything else falls back to the process working directory.
      const cwd = session.cwd !== undefined && isAbsolute(session.cwd) ? session.cwd : process.cwd()
      const meta: Record<string, unknown> = { cwd }
      const prepared = store.prepare(resumeId, { seed: this.buildSeedEvents(session), meta })
      store.enter(prepared)
      return prepared
    } catch (error) {
      console.warn(
        '[dsh-advisor-group] 重建会话句柄失败（降级为 detached）：',
        error instanceof Error ? error.message : String(error),
      )
      const again = store.get(resumeId)
      if (again) return again
      return this.buildDetachedSession(session, resumeId)
    }
  }

  private buildDetachedSession(session: ConsultSession, sessionId = session.id): Session | undefined {
    try {
      return Session.create(sessionId as SessionId, this.buildSeedEvents(session) as never, undefined, 0 as never)
    } catch {
      return undefined
    }
  }

  getRepeatPressure(sessionId?: string): { count: number; text: string } | undefined {
    if (!sessionId) return undefined
    const tracked = this.repeatTracker.get(sessionId)
    if (!tracked) return undefined
    return { count: tracked.count, text: tracked.text }
  }

  getConfig(): Config {
    return this.config
  }

  setConfig(config: Config): void {
    this.config = config
    this.enabled = config.enabled
  }

  isEnabled(): boolean {
    return this.enabled
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    this.config = { ...this.config, enabled }
  }

  setPersistEnabled(callback: (enabled: boolean) => Promise<void>): void {
    this.persistEnabledCallback = callback
  }

  async toggleEnabled(enabled: boolean): Promise<boolean> {
    this.setEnabled(enabled)
    if (this.persistEnabledCallback) {
      try {
        await this.persistEnabledCallback(enabled)
      } catch {
        // Keep the in-memory state; persistence will catch up on next save.
      }
    }
    return this.enabled
  }

  /**
   * Current daily-guard facts for display (does NOT increment — read-only).
   * Rolls the in-memory counter to a new UTC day view without persisting.
   * `enabled` reflects the configurable cap; `remaining` is -1 when the cap
   * is disabled (the counter still accumulates for visibility).
   */
  getDailyGuard(): { used: number; enabled: boolean; limit: number; remaining: number } {
    const today = new Date().toISOString().slice(0, 10)
    const used = this.dailyConsultationDate === today ? this.dailyConsultationCount : 0
    const enabled = this.config.quota.enabled
    const limit = this.config.quota.maxPerDay
    return {
      used,
      enabled,
      limit,
      remaining: enabled ? Math.max(0, limit - used) : -1,
    }
  }

  /**
   * Minimal cost guard: atomically check and increment the per-day new
   * consultation counter. Node is single-threaded, so doing both inside one
   * synchronous block closes the TOCTOU window a two-step check would leave.
   * The cap is configurable (`quota.enabled` / `quota.maxPerDay`); when the
   * cap is disabled the counter still increments (used for display only).
   * The counter is persisted (UTC day key) so a harness restart does not
   * reset the quota; persistence is fire-and-forget after the sync block.
   */
  tryStartConsultation(): { ok: true } | { ok: false; reason: string } {
    const today = new Date().toISOString().slice(0, 10)
    if (this.dailyConsultationDate !== today) {
      this.dailyConsultationDate = today
      this.dailyConsultationCount = 0
    }
    if (this.config.quota.enabled && this.dailyConsultationCount >= this.config.quota.maxPerDay) {
      return { ok: false, reason: '今日顾问咨询次数已达上限，请明天再试，或在设置中调整每日咨询上限。' }
    }
    this.dailyConsultationCount += 1
    this.persistDailyGuard()
    return { ok: true }
  }

  getSession(id: string): ConsultSession | undefined {
    return this.sessions.get(id)
  }

  createSession(
    question: string,
    context: string | undefined,
    advisorIds: string[] = [],
    cwd?: string,
    dshSessionId?: string,
  ): ConsultSession {
    const maxAdvisors = this.config.discussion.maxAdvisorsPerCall
    const advisors = this.resolveAdvisors(advisorIds).slice(0, maxAdvisors)
    const now = Date.now()
    const session: ConsultSession = {
      id: randomUUID(),
      status: 'active',
      question,
      context,
      advisors,
      maxRounds: this.config.discussion.maxRounds,
      messages: [
        {
          role: 'system',
          content: `顾问群已建立，共 ${advisors.length} 位顾问。`,
          ts: now,
        },
        {
          role: 'main',
          content: context ? `${context}\n\n${question}` : question,
          ts: now,
        },
      ],
      cwd,
      dshSessionId,
      createdAt: now,
      updatedAt: now,
    }
    // Bound in-memory session cache: keep at most 100 sessions.
    if (this.sessions.size >= 100) {
      const oldest = this.sessions.keys().next().value
      if (oldest !== undefined) this.sessions.delete(oldest)
    }

    this.sessions.set(session.id, session)
    this.persistSession(session)
    this.ctx.emit('advisor-group/session-start', session)
    return session
  }

  appendFollowUp(sessionId: string, followUp: string, sessionLog?: Session): ConsultSession | undefined {
    const session = this.sessions.get(sessionId)
    if (!session) return undefined
    const message: ChatMessage = {
      role: 'main',
      content: followUp,
      ts: Date.now(),
    }
    session.messages.push(message)
    session.updatedAt = Date.now()
    if (sessionLog) appendAdvisorMessage(sessionLog, session.id, message)
    this.persistSession(session)
    this.ctx.emit('advisor-group/message', { sessionId: session.id, message })
    return session
  }

  /**
   * The next round that still needs work, derived from the durable messages:
   * when the last round is incomplete (an advisor answered, a later one was
   * cut by a stop), that round resumes with ONLY the missing advisors; when
   * it is complete, the next round is fresh. `undefined` means finished.
   */
  private nextPendingRound(session: ConsultSession): { round: number; answeredIds: string[] } | undefined {
    const advisorMessages = session.messages.filter((message) => message.role === 'advisor')
    const maxRound = advisorMessages.reduce((max, message) => Math.max(max, message.round ?? 1), 0)
    const advisorCount = Math.max(1, session.advisors.length)
    if (maxRound === 0) {
      return { round: 1, answeredIds: [] }
    }
    if (maxRound > session.maxRounds) return undefined
    const answeredInMax = advisorMessages
      .filter((message) => (message.round ?? 1) === maxRound)
      .map((message) => message.advisorId ?? '')
      .filter((id) => id !== '') as string[]
    const unique = [...new Set(answeredInMax)]
    if (unique.length < advisorCount) {
      return { round: maxRound, answeredIds: unique }
    }
    if (maxRound + 1 > session.maxRounds) return undefined
    return { round: maxRound + 1, answeredIds: [] }
  }

  /** Number of main-model messages: the opening question + all deep-questions. */
  private mainMessageCount(session: ConsultSession): number {
    return session.messages.filter((message) => message.role === 'main').length
  }

  /** Run exactly one round: every advisor that has NOT answered this round. */
  async runRoundFrom(
    session: ConsultSession,
    round: number,
    answeredIds: string[],
    signal?: AbortSignal,
    sessionLog?: Session,
    agent?: AdvisorAgent,
  ): Promise<void> {
    // Sequential relay: each advisor sees the project background + the main
    // question + every answer from the advisors that joined BEFORE it in this
    // same round, and is prompted to give its own view (agree / complement /
    // rebut). The transcript is rebuilt per advisor, so B sees A's fresh reply.
    for (let index = 0; index < session.advisors.length; index++) {
      const advisor = session.advisors[index]
      if (answeredIds.includes(advisor.id)) continue
      const transcript = this.buildTranscript(session)
      await this.callAdvisor(session, advisor, transcript, round, index + 1, signal, sessionLog, agent)
    }
    session.status = 'active'
    session.updatedAt = Date.now()
    this.persistSession(session)
  }

  async runOneRound(
    session: ConsultSession,
    signal?: AbortSignal,
    sessionLog?: Session,
    agent?: AdvisorAgent,
  ): Promise<void> {
    const pending = this.nextPendingRound(session)
    if (!pending) return
    await this.runRoundFrom(session, pending.round, pending.answeredIds, signal, sessionLog, agent)
  }

  /**
   * Auto-deepen pipeline (2026-09-05): one ask_advisors call runs the whole
   * consultation — up to `maxRounds` rounds, each round being
   *   [driver deep-question (after the first)] → advisor A → advisor B (sees A)
   *   → advisor C (sees A+B) → …
   * and closes with a driver-generated conclusion. The pipeline is synchronous
   * (SSE keeps the card streaming); `exec.signal` aborts the whole run and the
   * user may stop it explicitly via `stopConsultation(sessionId)` (POST
   * /advisor-group/stop) — a stop degrades to a graceful partial summary.
   *
   * Resumption: after a stop (or a dsh restart that restored the snapshot)
   * `resumeConsultation()` re-enters the SAME pipeline; `nextPendingRound()`
   * detects the interruption point — a partially-answered round is completed
   * with only the missing advisors (the deep-question is NOT regenerated for
   * that round), then remaining rounds run as usual.
   */
  async runAutoPipeline(
    session: ConsultSession,
    signal?: AbortSignal,
    sessionLog?: Session,
    agent?: AdvisorAgent,
  ): Promise<ConsultSummary> {
    const stop = new AbortController()
    this.activeAborts.set(session.id, stop)
    const combined = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal
    // Capture the driver source at FIRST run: a resume runs on a rebuilt
    // session (no request/header event), so the conclusion would otherwise
    // degrade to the static fallback text.
    if (!session.driverSource) {
      const source = resolveDriverSource(sessionLog, this.config.discussion.driverModel)
      if (source) {
        session.driverSource = source
        this.persistSession(session)
      }
    }
    try {
      while (true) {
        const pending = this.nextPendingRound(session)
        if (!pending) break
        const freshRound = pending.answeredIds.length === 0
        // Generate the deep-question only when this round does not already
        // have one: a resume that was stopped BETWEEN rounds finds the
        // follow-up already in the message log (the question was pushed before
        // the first advisor of the round started), and must not ask it twice.
        const questionAlreadyAsked = this.mainMessageCount(session) >= pending.round
        if (
          pending.round > 1 &&
          freshRound &&
          this.config.discussion.autoDeepen &&
          !questionAlreadyAsked
        ) {
          const question = await generateDeepenQuestion(
            this.ctx,
            session,
            session.driverSource ?? resolveDriverSource(sessionLog, this.config.discussion.driverModel),
            combined,
          )
          this.appendMainMessage(session, question, sessionLog)
        }
        await this.runRoundFrom(session, pending.round, pending.answeredIds, combined, sessionLog, agent)
      }
      session.status = 'completed'
      session.stopReason = undefined
      const summary = await this.generateFinalSummary(session, combined, sessionLog, false)
      this.persistSession(session)
      await this.flushLog(sessionLog)
      return summary
    } catch (error) {
      if (isAbortError(error, combined) || stop.signal.aborted) {
        // Distinguish the interruption cause: an explicit user stop vs a host
        // signal vs an unclassified AbortError (e.g. the mysterious ~90s
        // mid-stream abort). Future auto-retry MUST NOT retry a user stop.
        if (stop.signal.aborted) {
          session.stopReason = 'user-stop'
        } else if (signal?.aborted) {
          session.stopReason = 'exec-cancel'
        } else {
          session.stopReason = 'abort-error'
        }
        session.status = 'cancelled'
        this.persistSession(session)
        const summary = await this.generateFinalSummary(session, undefined, sessionLog, true)
        await this.flushLog(sessionLog)
        return summary
      }
      throw error
    } finally {
      this.activeAborts.delete(session.id)
    }
  }

  /**
   * User-initiated stop: aborts the in-flight consultation pipeline. Returns
   * whether a running consultation was found and aborted.
   */
  stopConsultation(sessionId: string): boolean {
    const stop = this.activeAborts.get(sessionId)
    if (!stop) return false
    stop.abort()
    return true
  }

  /**
   * Resume a stopped/interrupted consultation from its interruption point.
   * Works for a user stop (live session) and after a dsh restart (snapshot
   * restored; the DSH session handle is rebuilt via `prepare` + `enter`).
   * Returns immediately; the pipeline runs in the background and streams over
   * the existing SSE channel, then closes with a fresh `advisor-group/end`.
   */
  resumeConsultation(sessionId: string): { ok: boolean; reason?: string } {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return { ok: false, reason: '咨询会话不存在或已过期，请重新发起咨询。' }
    }
    if (this.activeAborts.has(sessionId)) {
      return { ok: false, reason: '该咨询正在运行中，无需继续。' }
    }
    if (session.status === 'completed' || this.nextPendingRound(session) === undefined) {
      return { ok: false, reason: '该咨询已完成，无需继续。' }
    }
    if (session.advisors.length === 0) {
      return { ok: false, reason: '恢复失败：当前配置无法匹配该咨询的原顾问（顾问配置可能已被修改）。' }
    }
    // Cross-instance lock: a second dsh (or headless) process sharing the same
    // DSH_HOME must not run the same resume concurrently (double writes,
    // duplicate events, snapshot races). Stale locks (crashed holder) are
    // taken over after 10 minutes.
    if (!this.acquireResumeLock(session.id)) {
      return {
        ok: false,
        reason: '该咨询正在另一实例中恢复，请稍后再试（若确认无其他实例运行，10 分钟后会自动接管该锁）。',
      }
    }
    const dshSession = this.resolveSessionHandle(session)
    // Resolve the live agent for tool scoping (session tools) when available.
    const agentRegistry = (this.ctx as unknown as { agents?: { get?: (id: string) => AdvisorAgent | undefined } }).agents
    const resumeAgent =
      session.dshSessionId !== undefined && agentRegistry?.get
        ? (agentRegistry.get as (id: string) => AdvisorAgent | undefined)(session.dshSessionId)
        : undefined
    session.status = 'active'
    session.stopReason = undefined
    session.updatedAt = Date.now()
    this.persistSession(session)
    if (dshSession) appendAdvisorResume(dshSession, session.id)
    this.ctx.emit('advisor-group/resume', { sessionId: session.id })
    void this.runAutoPipeline(session, undefined, dshSession, resumeAgent)
      .catch(() => {
        // The pipeline degrades silently per its own contract; the snapshot
        // and SSE channel already captured everything it produced.
      })
      .finally(() => this.releaseResumeLock(session.id))
    return { ok: true }
  }

  /** Atomic cross-instance lock (mkdir-based, with stale takeover). */
  private acquireResumeLock(sessionId: string): boolean {
    const lockDir = join(this.sessionsDir, `${sessionId}.lock`)
    try {
      // Ensure the parent exists, then a NON-recursive mkdir: it is atomic and
      // throws when the lock already exists (a recursive mkdir would silently
      // succeed and defeat the mutual exclusion).
      mkdirSync(this.sessionsDir, { recursive: true })
      mkdirSync(lockDir)
      try {
        writeFileSync(join(lockDir, 'owner'), String(process.pid), 'utf8')
      } catch {
        // Best effort; possession is the lock.
      }
      return true
    } catch {
      // Lock exists: check staleness (owner crashed or process gone).
      try {
        const stat = statSync(lockDir)
        if (Date.now() - stat.mtimeMs > 10 * 60_000) {
          rmSync(lockDir, { recursive: true, force: true })
          mkdirSync(lockDir)
          return true
        }
      } catch {
        // Raced with the holder releasing; fall through to refusal.
      }
      return false
    }
  }

  private releaseResumeLock(sessionId: string): void {
    try {
      rmSync(join(this.sessionsDir, `${sessionId}.lock`), { recursive: true, force: true })
    } catch {
      // Already gone: nothing to release.
    }
  }

  private async generateFinalSummary(
    session: ConsultSession,
    signal: AbortSignal | undefined,
    sessionLog: Session | undefined,
    stopped: boolean,
  ): Promise<ConsultSummary> {
    session.updatedAt = Date.now()
    const summary = this.buildSummary(session, stopped)
    const conclusion = stopped
      ? ''
      : await generateConclusion(
          this.ctx,
          session,
          session.driverSource ?? resolveDriverSource(sessionLog, this.config.discussion.driverModel),
          signal,
        )
    const finalSummary: ConsultSummary = stopped
      ? { ...summary, stopped: true }
      : { ...summary, conclusion }
    if (sessionLog) appendAdvisorEnd(sessionLog, session, finalSummary)
    this.ctx.emit('advisor-group/session-end', { sessionId: session.id, summary: finalSummary })
    return finalSummary
  }

  private appendMainMessage(session: ConsultSession, content: string, sessionLog?: Session): void {
    const message: ChatMessage = { role: 'main', content, ts: Date.now() }
    session.messages.push(message)
    if (sessionLog) appendAdvisorMessage(sessionLog, session.id, message)
    this.persistSession(session)
    this.ctx.emit('advisor-group/message', { sessionId: session.id, message })
  }

  /**
   * Run exactly ONE discussion round: the main model's question -> each
   * advisor answers once. Cross-advisor discussion is driven by the main model
   * calling ask_advisors again with sessionId + followUp, never by the
   * advisor models talking to themselves back-to-back.
   */
  async runOneRoundAndSummarize(
    session: ConsultSession,
    signal?: AbortSignal,
    sessionLog?: Session,
    agent?: AdvisorAgent,
  ): Promise<ConsultSummary> {
    await this.runOneRound(session, signal, sessionLog, agent)
    session.status = 'completed'
    session.updatedAt = Date.now()
    const summary = this.buildSummary(session, false)
    if (sessionLog) appendAdvisorEnd(sessionLog, session, summary)
    this.persistSession(session)
    await this.flushLog(sessionLog)
    this.ctx.emit('advisor-group/session-end', { sessionId: session.id, summary })
    // Keep the session in memory: ask_advisors returns the session id so the
    // main model can continue with a follow-up question in a later call.
    return summary
  }

  getRoundCount(session: ConsultSession): number {
    const advisorCount = Math.max(1, session.advisors.length)
    return Math.floor(
      session.messages.filter((message) => message.role === 'advisor').length / advisorCount,
    )
  }

  hasReachedMaxRounds(session: ConsultSession): boolean {
    const maxRounds = Math.max(1, session.maxRounds)
    return this.getRoundCount(session) >= maxRounds
  }

  private resolveAdvisors(advisorIds: string[]): AdvisorConfig[] {
    if (advisorIds.length === 0) return this.config.advisors
    return this.config.advisors.filter((advisor) => advisorIds.includes(advisor.id))
  }

  private buildTranscript(session: ConsultSession): TranscriptEntry[] {
    // Preserve the actual back-and-forth order: main question -> advisor reply
    // -> main follow-up -> advisor reply ... Keep the window bounded. The bound
    // is deliberately tight (12 msgs x 3000 chars): a long-reasoning model with
    // a big context spends its reply budget on thinking and loses the body, so
    // later-round transcripts stay lean (see ADVISOR_OUTPUT_POLICY).
    return session.messages
      .filter((message) => message.role !== 'system')
      .slice(-12)
      .map((message): TranscriptEntry | null => {
        if (message.role === 'main') {
          return { role: 'main', name: '主模型', content: message.content.slice(0, 3000) }
        }
        if (message.role === 'advisor' && message.advisorName) {
          return {
            role: 'advisor',
            name: message.advisorName,
            content: message.content.slice(0, 3000),
          }
        }
        return null
      })
      .filter((entry): entry is TranscriptEntry => entry !== null)
  }

  private async callAdvisor(
    session: ConsultSession,
    advisor: AdvisorConfig,
    transcript: TranscriptEntry[],
    round: number,
    joinIndex: number,
    signal?: AbortSignal,
    sessionLog?: Session,
    agent?: AdvisorAgent,
  ): Promise<void> {
    // Sequential-relay role hint is folded into the advisor's system prompt;
    // the provider functions append ADVISOR_OUTPUT_POLICY after it.
    const relational = { ...advisor }
    relational.systemPrompt = `${advisor.systemPrompt}\n${advisorJoinPrompt(joinIndex, session.advisors.length)}`
    const message: ChatMessage = {
      role: 'advisor',
      advisorId: advisor.id,
      advisorName: advisor.name,
      content: '',
      round,
      ts: Date.now(),
    }

    try {
      let content: string
      let isDshLlmProvider = false
      try {
        const llmProviders = this.ctx.llm.listProviders()
        isDshLlmProvider = llmProviders.some((item: { id: string }) => item.id === advisor.provider)
      } catch {
        // If provider listing is unavailable, treat as direct HTTP.
      }

      // Shared streaming pipeline for both provider paths: publish every delta
      // to the SSE channel immediately and batch durable session-log deltas so
      // the retro card can stream thinking + text as they arrive.
      let pendingText = ''
      let pendingThinking = ''
      let timer: ReturnType<typeof setTimeout> | null = null
      const flush = () => {
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        if (!pendingText && !pendingThinking) return
        if (sessionLog) {
          appendAdvisorDelta(sessionLog, session.id, {
            sessionId: session.id,
            advisorId: advisor.id,
            advisorName: advisor.name,
            round,
            contentDelta: pendingText || undefined,
            thinkingDelta: pendingThinking || undefined,
            done: false,
          })
        }
        pendingText = ''
        pendingThinking = ''
      }
      const emitDelta = (delta: { text?: string; thinking?: string }) => {
        if (delta.text) {
          message.content += delta.text
          pendingText += delta.text
        }
        if (delta.thinking) {
          message.thinking = (message.thinking ?? '') + delta.thinking
          pendingThinking += delta.thinking
        }
        publish(session.id, {
          advisorId: advisor.id,
          advisorName: advisor.name,
          round,
          contentDelta: delta.text,
          thinkingDelta: delta.thinking,
          done: false,
        })
        if (!timer) timer = setTimeout(flush, 200)
      }

      // Non-DSH providers (preset/custom) must go through direct HTTP; ctx.llm
      // may silently stream nothing for an unknown provider instead of throwing.
      const advisorTimeoutMs = this.config.discussion.advisorTimeoutMs
      let truncated: TruncationInfo | undefined
      if (!isDshLlmProvider || advisor.baseURL || advisor.apiKey || advisor.apiKeyEnv) {
        // Advisor tool calling (2026-09-05): when the direct-http OpenAI/Anthropic
        // channel is in use and the configured scope resolves session-visible
        // tools, run the tool loop — the model may call read/grep/web_search etc.
        // before answering; every invocation runs through the official pipeline
        // (scoped dispatch via `agent`), recorded in the 💭 thinking panel.
        const toolSchemas = resolveAdvisorToolSchemas(this.ctx, agent, this.config.discussion.advisorTools ?? 'readonly')
        if (toolSchemas.length > 0) {
          const streamOnce = (tools: typeof toolSchemas, extra: string) => {
            const withExtra = extra.trim()
              ? [...transcript, { role: 'main' as const, name: '已执行工具', content: extra.trim() }]
              : transcript
            return streamDirectHttp(relational, withExtra, emitDelta, signal, advisorTimeoutMs, tools).then((result) => ({
              content: result.content,
              thinking: result.thinking,
              toolCalls: result.toolCalls ?? [],
              truncated: result.truncated,
            }))
          }
          const loop = await runAdvisorToolLoop(
            toolSchemas,
            streamOnce,
            (call) => executeAdvisorTool(this.ctx, agent, call, signal),
            (text) => emitDelta({ thinking: text }),
          )
          flush()
          content = loop.content
          truncated = loop.truncated
        } else {
          const streamResult = await streamDirectHttp(relational, transcript, emitDelta, signal, advisorTimeoutMs)
          flush()
          content = streamResult.content
          message.thinking = streamResult.thinking
          truncated = streamResult.truncated
        }
      } else {
        const result = await callViaCtxLlm(this.ctx, relational, transcript, signal, emitDelta, advisorTimeoutMs)
        flush()
        content = result.content
        truncated = result.truncated
      }
      message.content = content
      if (truncated) message.truncated = truncated
    } catch (error) {
      if (isAbortError(error, signal)) throw error
      message.content = `（顾问调用失败：${error instanceof Error ? error.message : String(error)}）`
    }

    publish(session.id, {
      advisorId: advisor.id,
      advisorName: advisor.name,
      round,
      done: true,
    })

    session.messages.push(message)
    if (sessionLog) appendAdvisorMessage(sessionLog, session.id, message)
    session.updatedAt = Date.now()
    this.persistSession(session)
    this.ctx.emit('advisor-group/message', { sessionId: session.id, message })
  }

  private buildSummary(session: ConsultSession, cancelled = false): ConsultSummary {
    const advisorMessages = session.messages.filter((message) => message.role === 'advisor')
    const byAdvisor = new Map<string, ChatMessage[]>()
    for (const message of advisorMessages) {
      const list = byAdvisor.get(message.advisorId ?? '') ?? []
      list.push(message)
      byAdvisor.set(message.advisorId ?? '', list)
    }

    const advisors: AdvisorSummary[] = [...byAdvisor.entries()].map(([id, messages]) => {
      const advisor = session.advisors.find((item) => item.id === id)
      const meaningful = messages.filter(
        (message) => message.content && message.content.trim() && !message.content.startsWith('（顾问调用失败'),
      )
      const last = meaningful[meaningful.length - 1] ?? messages[messages.length - 1]
      return {
        advisorId: id,
        advisorName: advisor?.name ?? id,
        corePoints: last ? this.extractCorePoints(last.content) : [],
      }
    })

    const riskNotes = advisorMessages.some((message) => /风险|注意|不确定|risk|uncertain|confidence/i.test(message.content))
      ? ['部分顾问提到了风险、不确定性或置信度较低，请主模型谨慎采用。']
      : []
    if (advisorMessages.some((message) => message.truncated !== undefined)) {
      riskNotes.push('有顾问输出在流式过程中被截断（超时或网络中断），其正文可能不完整，且该顾问本轮可能只提供了部分意见。')
    }

    if (cancelled) {
      riskNotes.push('本次顾问群讨论已被用户或主模型取消，结论可能不完整。')
    }

    return {
      sessionId: session.id,
      question: session.question,
      advisors,
      consensus: [],
      disagreements: [],
      riskNotes,
    }
  }

  private extractCorePoints(content: string): string[] {
    const lines = content
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    return lines.slice(0, 5)
  }
}
