import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { AdvisorConfig, Config } from './config'
import { callViaCtxLlm, type TranscriptEntry } from './providers/ctx-llm'
import { streamDirectHttp } from './providers/direct-http'
import { advisorJoinPrompt } from './providers/advisor-prompt'
import { generateConclusion, generateDeepenQuestion, resolveDriverSource } from './driver'
import { appendAdvisorDelta, appendAdvisorEnd, appendAdvisorMessage } from './session-log'
import { publish } from './stream-channel'
import type { ChatMessage, ConsultSession, ConsultSummary, AdvisorSummary } from './types'
import './events'

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  return error instanceof Error && error.name === 'AbortError'
}

interface RepeatTrack {
  text: string
  count: number
}

const MAX_DAILY_CONSULTATIONS = 50

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
    this.loadDailyGuard()
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
   */
  getDailyGuard(): { used: number; limit: number; remaining: number } {
    const today = new Date().toISOString().slice(0, 10)
    const used = this.dailyConsultationDate === today ? this.dailyConsultationCount : 0
    return {
      used,
      limit: MAX_DAILY_CONSULTATIONS,
      remaining: Math.max(0, MAX_DAILY_CONSULTATIONS - used),
    }
  }

  /**
   * Minimal cost guard: atomically check and increment the per-day new
   * consultation counter. Node is single-threaded, so doing both inside one
   * synchronous block closes the TOCTOU window a two-step check would leave.
   * The counter is persisted (UTC day key) so a harness restart does not
   * reset the quota; persistence is fire-and-forget after the sync block.
   */
  tryStartConsultation(): { ok: true } | { ok: false; reason: string } {
    const today = new Date().toISOString().slice(0, 10)
    if (this.dailyConsultationDate !== today) {
      this.dailyConsultationDate = today
      this.dailyConsultationCount = 0
    }
    if (this.dailyConsultationCount >= MAX_DAILY_CONSULTATIONS) {
      return { ok: false, reason: '今日顾问咨询次数已达上限，请明天再试或调整配置。' }
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
  ): ConsultSession {
    const maxAdvisors = this.config.discussion.maxAdvisorsPerCall
    const advisors = this.resolveAdvisors(advisorIds).slice(0, maxAdvisors)
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
          ts: Date.now(),
        },
        {
          role: 'main',
          content: context ? `${context}\n\n${question}` : question,
          ts: Date.now(),
        },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    // Bound in-memory session cache: keep at most 100 sessions.
    if (this.sessions.size >= 100) {
      const oldest = this.sessions.keys().next().value
      if (oldest !== undefined) this.sessions.delete(oldest)
    }

    this.sessions.set(session.id, session)
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
    this.ctx.emit('advisor-group/message', { sessionId: session.id, message })
    return session
  }

  async runOneRound(
    session: ConsultSession,
    signal?: AbortSignal,
    sessionLog?: Session,
  ): Promise<void> {
    const advisorCount = Math.max(1, session.advisors.length)
    const round =
      Math.floor(
        session.messages.filter((message) => message.role === 'advisor').length / advisorCount,
      ) + 1
    // Sequential relay: each advisor sees the project background + the main
    // question + every answer from the advisors that joined BEFORE it in this
    // same round, and is prompted to give its own view (agree / complement /
    // rebut). The transcript is rebuilt per advisor, so B sees A's fresh reply.
    for (let index = 0; index < session.advisors.length; index++) {
      const advisor = session.advisors[index]
      const transcript = this.buildTranscript(session)
      await this.callAdvisor(session, advisor, transcript, round, index + 1, signal, sessionLog)
    }
    session.status = 'active'
    session.updatedAt = Date.now()
  }

  /**
   * Auto-deepen pipeline (2026-09-05): one ask_advisors call runs the whole
   * consultation — up to `maxRounds` rounds, each round being
   *   [driver deep-question (after the first)] → advisor A → advisor B (sees A)
   *   → advisor C (sees A+B) → …
   * and closes with a driver-generated conclusion. The pipeline is synchronous
   * (SSE keeps the card streaming); `exec.signal` aborts the whole run.
   */
  async runAutoPipeline(
    session: ConsultSession,
    signal?: AbortSignal,
    sessionLog?: Session,
  ): Promise<ConsultSummary> {
    while (!this.hasReachedMaxRounds(session)) {
      const nextRound = this.getRoundCount(session) + 1
      if (nextRound > 1 && this.config.discussion.autoDeepen) {
        const question = await generateDeepenQuestion(
          this.ctx,
          session,
          resolveDriverSource(sessionLog, this.config.discussion.driverModel),
          signal,
        )
        this.appendMainMessage(session, question, sessionLog)
      }
      await this.runOneRound(session, signal, sessionLog)
    }
    session.status = 'completed'
    session.updatedAt = Date.now()
    const summary = this.buildSummary(session, false)
    const conclusion = await generateConclusion(
      this.ctx,
      session,
      resolveDriverSource(sessionLog, this.config.discussion.driverModel),
      signal,
    )
    const finalSummary: ConsultSummary = { ...summary, conclusion }
    if (sessionLog) appendAdvisorEnd(sessionLog, session, finalSummary)
    this.ctx.emit('advisor-group/session-end', { sessionId: session.id, summary: finalSummary })
    return finalSummary
  }

  private appendMainMessage(session: ConsultSession, content: string, sessionLog?: Session): void {
    const message: ChatMessage = { role: 'main', content, ts: Date.now() }
    session.messages.push(message)
    if (sessionLog) appendAdvisorMessage(sessionLog, session.id, message)
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
  ): Promise<ConsultSummary> {
    await this.runOneRound(session, signal, sessionLog)
    session.status = 'completed'
    session.updatedAt = Date.now()
    const summary = this.buildSummary(session, false)
    if (sessionLog) appendAdvisorEnd(sessionLog, session, summary)
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
    // -> main follow-up -> advisor reply ... Keep the window bounded.
    return session.messages
      .filter((message) => message.role !== 'system')
      .slice(-20)
      .map((message): TranscriptEntry | null => {
        if (message.role === 'main') {
          return { role: 'main', name: '主模型', content: message.content.slice(0, 4000) }
        }
        if (message.role === 'advisor' && message.advisorName) {
          return {
            role: 'advisor',
            name: message.advisorName,
            content: message.content.slice(0, 4000),
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
          contentDelta: delta.text,
          thinkingDelta: delta.thinking,
          done: false,
        })
        if (!timer) timer = setTimeout(flush, 200)
      }

      // Non-DSH providers (preset/custom) must go through direct HTTP; ctx.llm
      // may silently stream nothing for an unknown provider instead of throwing.
      const advisorTimeoutMs = this.config.discussion.advisorTimeoutMs
      if (!isDshLlmProvider || advisor.baseURL || advisor.apiKey || advisor.apiKeyEnv) {
        const streamResult = await streamDirectHttp(relational, transcript, emitDelta, signal, advisorTimeoutMs)
        flush()
        content = streamResult.content
        message.thinking = streamResult.thinking
      } else {
        content = await callViaCtxLlm(this.ctx, relational, transcript, signal, emitDelta, advisorTimeoutMs)
        flush()
      }
      message.content = content
    } catch (error) {
      if (isAbortError(error, signal)) throw error
      message.content = `（顾问调用失败：${error instanceof Error ? error.message : String(error)}）`
    }

    publish(session.id, {
      advisorId: advisor.id,
      advisorName: advisor.name,
      done: true,
    })

    session.messages.push(message)
    if (sessionLog) appendAdvisorMessage(sessionLog, session.id, message)
    session.updatedAt = Date.now()
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
