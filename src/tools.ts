import { defineTool } from '@deepseek-ai/dsh-tools'
import { advisorsMissingModel } from './model-validation'
import { appendShadowSample, type ShadowSample } from './shadow'
import { classifyRequest } from './classifier'
import { classifyWithJev, type JevClassificationResult } from './providers/jev'
import type { AdvisorGroupService } from './service'
import { appendAdvisorStart, appendAskAnswer, appendAskStart } from './session-log'
import {
  askSession,
  sessionDisplayName,
  ASK_WAIT_DEFAULT_MS,
  ASK_WAIT_MAX_MS,
  getSessionController,
  askStoreRoot,
  renderAskResult,
  type AskCardDelivery,
  type AskCardSettle,
  type AskReply,
  type CrossSessionLogEvent,
} from './cross-session'
import type { ConsultSession, ConsultSummary } from './types'
import { buildSessionRoster, renderRoster, type RosterRow } from './session-roster'
import { listAskRecords, readAskRecord, type AskRecord } from './ask-store'
import type { Session } from '@deepseek-ai/dsh-session'

export function registerAdvisorTools(
  service: AdvisorGroupService,
  ctx?: unknown,
): Array<ReturnType<typeof defineTool>> {
  const askAdvisors = defineTool({
    name: 'ask_advisors',
    description:
      'Consult configured expert advisor models when the question is professional, long-tail world knowledge, high-risk, or the main model is uncertain. ALWAYS provide context with (a) a brief overview of the current project and (b) concrete details of the problem, including what has been tried and what went wrong. Also call immediately when the user @顾问群 or repeats the same question three times without resolution. Do NOT use for simple facts that web search can answer. Starting a new consultation runs the auto-deepen pipeline: up to maxRounds rounds of [driver deep-question → advisor A → advisor B (sees A) → advisor C (sees A+B) → …], closed by a driver-generated conclusion.',
    parameters: {
      question: { type: 'string', description: 'The question to ask the advisors. Required when starting a new consultation.' },
      context: { type: 'string', description: 'Required background: (a) current project overview (domain/goal/stack/constraints) and (b) problem details (steps tried, expected vs actual, errors). Write "该项背景未知" for anything unknown; never leave it empty.' },
      sessionId: { type: 'string', description: 'Existing consultation session id to continue.' },
      followUp: { type: 'string', description: 'Follow-up question to send to the advisors in an existing session.' },
      advisorIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional advisor ids to include; defaults to all configured advisors (capped by maxAdvisorsPerCall).',
      },
      confidence: {
        type: 'number',
        // NOTE: dsh-tools value schema DSL does not support minimum/maximum
        // (author keys limited to type/enum/const + annotations). Range is
        // enforced in execute() below.
        description: 'Optional self-assessed confidence 0-1. Values below the configured threshold escalate even without domain keywords.',
      },
      questionEn: {
        type: 'string',
        description:
          'Optional self-contained English gist of the question plus key background. Used as the Jev pre-classification input only when the「Jev 英文判定」setting is enabled; the displayed question, session records, and duplicate detection always keep using question/context in Chinese. Omit it otherwise.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', required: true },
          advice: { type: 'string', required: true },
          skipped: { type: 'boolean' },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.advice }],
    },
    async execute(args, exec) {
      const cfg = service.getConfig()
      if (args.confidence !== undefined && (args.confidence < 0 || args.confidence > 1)) {
        return {
          sessionId: '',
          advice: 'confidence 参数必须在 0-1 之间。',
          skipped: true,
          reason: 'invalid-confidence',
        }
      }
      if (!service.isEnabled()) {
        return {
          sessionId: '',
          advice: '顾问群插件已禁用。请先调用 toggle_advisor_group 启用。',
          skipped: true,
          reason: 'disabled',
        }
      }

      if (cfg.advisors.length === 0) {
        return {
          sessionId: '',
          advice: '顾问群尚未配置任何顾问。请先到 设置 → 插件 → 顾问群 添加顾问。',
          skipped: true,
          reason: 'no-advisors',
        }
      }

      const withoutModel = advisorsMissingModel(cfg)
      if (withoutModel.length > 0) {
        return {
          sessionId: '',
          advice: `顾问群中有 ${withoutModel.length} 位顾问未配置模型（${withoutModel
            .map((a) => a.name)
            .join('、')}）。请先到 设置 → 插件 → 顾问群 补全模型后再发起，避免整轮调用失败。`,
          skipped: true,
          reason: 'advisor-model-missing',
        }
      }

      const sessionLog = exec.agent?.session
      const questionText = typeof args.question === 'string' ? args.question : ''
      const contextText = typeof args.context === 'string' ? args.context : ''
      const mentionedAdvisorGroup = /@顾问群|@顧問群/.test(`${questionText}\n${contextText}`)
      const repeatPressure = service.getRepeatPressure(sessionLog?.id)
      const repeatCount = repeatPressure?.count ?? 0
      const forcedByRepeat = repeatCount >= 3
      // Measurement (2026-09-29, advisor-review ruling): one shadow sample per
      // routing decision, written where the branch resolves so `launched` states
      // the real outcome instead of copying `shouldEscalate`. Forced runs
      // (@ mention / repeat escalation) get a bypass sample, because a repeat
      // escalation is direct evidence that earlier turns should have called.
      let shadow: Omit<ShadowSample, 'launched'> | undefined
      let shadowWritten = false
      const recordShadow = (launched: boolean) => {
        if (!shadow || shadowWritten) return
        shadowWritten = true
        appendShadowSample({ ...shadow, launched })
      }

      // Continue an existing interactive consultation with a follow-up question.
      if (args.sessionId) {
        if (!args.followUp) {
          return {
            sessionId: args.sessionId,
            advice: '继续追问需要提供 followUp 参数。',
            skipped: true,
            reason: 'missing-follow-up',
          }
        }
        const session = service.getSession(args.sessionId)
        if (!session) {
          return {
            sessionId: args.sessionId,
            advice: '顾问群会话不存在或已过期，请重新发起 ask_advisors。',
            skipped: true,
            reason: 'session-not-found',
          }
        }
        if (service.isSessionRunning(session.id)) {
          return {
            sessionId: session.id,
            advice: '该顾问群会话正在运行中，请等本轮结束后再追问。',
            skipped: true,
            reason: 'session-running',
          }
        }
        if (service.hasReachedMaxRounds(session)) {
          return {
            sessionId: session.id,
            advice: '本轮已是顾问群讨论的最后一轮，请综合现有顾问意见给出最终答复，不要再追问。',
            skipped: true,
            reason: 'max-rounds-reached',
          }
        }
        service.appendFollowUp(session.id, args.followUp, sessionLog)
        const summary = await service.runOneRoundAndSummarize(session, exec.signal, sessionLog, exec.agent)
        const canContinue = !service.hasReachedMaxRounds(session)
        return {
          sessionId: session.id,
          advice:
            formatConversation(session) +
            formatRiskNotes(summary) +
            (canContinue
              ? '\n\n（如需继续，可再次传入 sessionId 和 followUp 追问。）'
              : '\n\n（讨论轮数已达上限，请综合顾问意见给出最终答复。）'),
          skipped: false,
        }
      }

      if (!args.question) {
        return {
          sessionId: '',
          advice: '发起新讨论需要提供 question 参数。',
          skipped: true,
          reason: 'missing-question',
        }
      }

      if (cfg.trigger.requireClassifier && !mentionedAdvisorGroup && !forcedByRepeat) {
        let classification
        let jevResult: JevClassificationResult | undefined
        let jevError: string | undefined
        let jevLatencyMs: number | undefined
        const jev = cfg.trigger.jev
        if (jev?.enabled) {
          const jevStartedAt = Date.now()
          try {
            jevResult = await classifyWithJev(
              args.question,
              args.context,
              cfg.advisors,
              jev,
              exec.signal,
              typeof args.questionEn === 'string' ? args.questionEn : undefined,
            )
            classification = jevResult
          } catch (error) {
            if (exec.signal.aborted) throw error
            jevError = error instanceof Error ? error.message : String(error)
            console.warn(
              '[dsh-advisor-group] Jev 分类失败，回退到本地分类器：',
              sessionLog?.id ?? 'no-session',
              jevError,
            )
          } finally {
            jevLatencyMs = Date.now() - jevStartedAt
          }
        }
        classification ??= classifyRequest(
            args.question,
            args.context,
            cfg.advisors,
            args.confidence,
            cfg.trigger.confidenceThreshold,
          )
        // Shadow sample: every judged verdict, for threshold tuning. Fire-and-
        // forget; never influences behavior.
        shadow = {
          ts: Date.now(),
          question: args.question,
          ...(typeof args.confidence === 'number' ? { confidence: args.confidence } : {}),
          shouldEscalate: classification.shouldEscalate,
          reason: classification.reason,
          suggestWebSearch: classification.suggestWebSearch,
          // Jev succeeded only when its verdict survived; otherwise this line
          // documents the local classifier (and `jevError` says why).
          provider: jevResult ? 'jev' : 'local',
          ...(jevError === undefined ? {} : { jevError }),
          ...(jevLatencyMs === undefined ? {} : { jevLatencyMs }),
          ...(repeatCount > 0 ? { repeatCount } : {}),
          ...(jevResult?.rawAnswers ? { scores: jevResult.rawAnswers } : {}),
          ...(jevResult?.model ? { model: jevResult.model } : {}),
        }
        if (!classification.shouldEscalate) {
          recordShadow(false)
          if (classification.suggestWebSearch && cfg.trigger.allowWebFallback) {
            return {
              sessionId: '',
              advice: `前置分类器建议不启动顾问群：${classification.reason}`,
              skipped: true,
              reason: 'web-search-recommended',
            }
          }
          return {
            sessionId: '',
            advice: `前置分类器建议不启动顾问群：${classification.reason}`,
            skipped: true,
            reason: 'classifier-rejected',
          }
        }
      } else if (cfg.trigger.requireClassifier) {
        // The gate never judged this call: either the user typed @顾问群, or the
        // same question came back a third time. Record it — a repeat escalation
        // means the earlier turns should have called and did not.
        shadow = {
          ts: Date.now(),
          question: args.question,
          shouldEscalate: true,
          reason: mentionedAdvisorGroup
            ? '用户点名 @顾问群，跳过前置分类器。'
            : `同一问题已重复 ${repeatCount} 次，强制升级跳过前置分类器。`,
          suggestWebSearch: false,
          provider: 'bypass',
          bypass: mentionedAdvisorGroup ? 'mention' : 'repeat',
          repeatCount,
        }
      }

      if (args.advisorIds && args.advisorIds.length > 0) {
        const configuredIds = new Set(cfg.advisors.map((advisor) => advisor.id))
        const matched = args.advisorIds.filter((id) => configuredIds.has(id))
        if (matched.length === 0) {
          recordShadow(false)
          return {
            sessionId: '',
            advice: '未匹配到任何指定顾问，请检查 advisorIds 是否与设置中的顾问 id 一致。',
            skipped: true,
            reason: 'no-matching-advisors',
          }
        }
      }

      const costGuard = service.tryStartConsultation()
      if (!costGuard.ok) {
        recordShadow(false)
        return {
          sessionId: '',
          advice: costGuard.reason,
          skipped: true,
          reason: 'daily-limit-reached',
        }
      }

      const session = service.createSession(
        args.question,
        args.context,
        args.advisorIds,
        sessionLog ? sessionLog.header.cwd : undefined,
        sessionLog ? sessionLog.id : undefined,
      )
      if (sessionLog) appendAdvisorStart(sessionLog, session)
      recordShadow(true)
      // Auto-deepen pipeline (2026-09-05): one call runs the whole consultation
      // — up to maxRounds rounds of [driver deep-question → A → B(sees A) →
      // C(sees A+B) …], closed by a driver-generated conclusion.
      const summary = await service.runAutoPipeline(session, exec.signal, sessionLog, exec.agent)
      return {
        sessionId: session.id,
        advice:
          formatConversation(session) +
          (summary.conclusion ? `\n\n【综合结论】\n${summary.conclusion}` : '') +
          formatRiskNotes(summary) +
          (service.hasReachedMaxRounds(session)
            ? '\n\n（已达设置的最大讨论轮数，请参考上述顾问意见与综合结论给出最终答复。）'
            : ''),
        skipped: false,
      }
    },
  })

  const toggleAdvisorGroup = defineTool({
    name: 'toggle_advisor_group',
    description: 'Enable or disable the advisor group plugin at runtime. Omit enabled to toggle the current state.',
    parameters: {
      enabled: { type: 'boolean', description: 'Optional desired state.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          enabled: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `顾问群插件已${value.enabled ? '启用' : '禁用'}。` }],
    },
    async execute(args) {
      const next = typeof args.enabled === 'boolean' ? args.enabled : !service.isEnabled()
      const enabled = await service.toggleEnabled(next)
      return { enabled }
    },
  })

  const askSessionTool = defineTool({
    name: 'ask_session',
    description:
      'Ask another EXISTING ordinary session (another window/tab the user opened) a question, wake it, and return what that session said. Use ONLY when the user explicitly asks to ask another session/window (「去问另一个会话」「问一下那个窗口」). It wakes the target session and consumes its quota. The returned text is NOT a one-to-one reply: it is everything the target said between the delivery receipt and its next whole-session idle, so never present it as "the answer to my message". When the target title is ambiguous you MUST return the candidates and let the user choose — never guess. Never use it for subagent sessions or for yourself.',
    parameters: {
      target: {
        type: 'string',
        description:
          'The target session, named the way the user names it: its exact title as shown in the session list (the session name in the sidebar), a natural partial name, or a full sessionId. A title or the workspace/directory name is usually enough (「极简遥控器」 matches sessions under I:\\极简遥控器\\…). One unique match is used directly; several matches return the candidates (running / most recently active first) and a miss returns the recent sessions — both for the USER to choose: never guess, and do NOT search session logs or directories for session ids.',
        required: true,
      },
      question: {
        type: 'string',
        description: 'The question to hand over. It is permanently recorded in the target session log, so write it self-contained.',
        required: true,
      },
      context: {
        type: 'string',
        description:
          'Optional background the target needs. Default: none. Anything sent here stays in the target session log forever, so send only what is necessary.',
      },
      waitMs: {
        type: 'number',
        description: `How long to wait for the target to finish, in milliseconds (default ${ASK_WAIT_DEFAULT_MS}, max ${ASK_WAIT_MAX_MS}). On timeout the already-collected text is returned and the target is NOT interrupted.`,
      },
      detach: {
        type: 'boolean',
        description:
          'Deliver without waiting: return immediately with an askId, then read the answer later with ask_result. Use it when the other session may take minutes, so this turn is not blocked. Ignored when waitMs is also given: pass only one.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          target: {
            type: 'object',
            additionalProperties: false,
            properties: {
              sessionId: { type: 'string', required: true },
              name: { type: 'string', required: true },
            },
          },
          delivered: { type: 'string', enum: ['native', 'fallback'] },
          detached: { type: 'boolean' },
          askId: { type: 'string' },
          interval: {
            type: 'object',
            additionalProperties: false,
            properties: {
              from: { type: 'string', required: true },
              // The enforced schema subset has one scalar `type` per node, so a
              // nullable ISO time is expressed as string-or-null.
              to: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              endedBecause: { type: 'string', enum: ['idle', 'timeout', 'error', 'detached'], required: true },
            },
            required: true,
          },
          answer: { type: 'string', required: true },
          status: { type: 'string', enum: ['ok', 'partial', 'failed'] },
          reply: {
            type: 'object',
            additionalProperties: false,
            properties: {
              conclusion: { type: 'string' },
              basis: { type: 'string' },
              uncertainty: { type: 'string' },
            },
          },
          note: { type: 'string', required: true },
          error: { type: 'string' },
          message: { type: 'string' },
          candidates: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string', required: true },
                name: { type: 'string', required: true },
                hint: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) =>
        value.ok === true
          ? renderAskResult({
              answer: String(value.answer ?? ''),
              note: String(value.note ?? ''),
              targetName: String((value.target as { readonly name?: unknown } | undefined)?.name ?? ''),
              askId: String(value.askId ?? ''),
              ...(value.status === 'ok' || value.status === 'partial' || value.status === 'failed'
                ? { status: value.status }
                : {}),
              ...(value.reply === null || typeof value.reply !== 'object'
                ? {}
                : { reply: value.reply as AskReply }),
            })
          : [
              {
                type: 'text',
                text: `【ask_session 未完成：${String(value.error ?? 'unknown')}】\n${String(value.message ?? '')}${
                  Array.isArray(value.candidates) && value.candidates.length > 0
                    ? `\n候选会话：\n${value.candidates
                        .map(
                          (item) =>
                            `- ${String((item as { readonly name?: unknown }).name ?? '')} · ${String(
                              (item as { readonly sessionId?: unknown }).sessionId ?? '',
                            )}`,
                        )
                        .join('\n')}`
                    : ''
                }`,
              },
            ],
    },
    async execute(args, exec) {
      const controller = getSessionController(ctx)
      if (!controller) {
        return {
          ok: false,
          error: 'service-missing',
          message:
            '此功能需要较新的 DSH 宿主：当前宿主没有提供 sessionController 服务，无法向其他会话投递问题。',
          answer: '',
          note: '',
          interval: errorInterval(),
        }
      }

      const session = exec.agent?.session ?? getCurrentSessionFrom(exec)
      const sessionId = session?.id
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return {
          ok: false,
          error: 'service-missing',
          message: '无法确定当前会话的身份（工具执行上下文没有暴露会话），已拒绝投递。',
          answer: '',
          note: '',
          interval: errorInterval(),
        }
      }

      const question = typeof args.question === 'string' ? args.question : ''
      const context = typeof args.context === 'string' ? args.context : undefined

      let senderName = '未命名会话'
      try {
        const listed = await controller.list({}, exec.signal)
        const own = listed.items.find((item) => item.sessionId === sessionId)
        if (own) senderName = sessionDisplayName(own)
      } catch {
        // Naming is cosmetic: a failed list must not block the ask.
      }

      // Cross-session card: append start/end events to this session's log so
      // the client assembles the chat-group card exactly like the advisor
      // flow. Card writes are cosmetic — never let them break the ask.
      const cardLog = session
      const onDelivered = (info: AskCardDelivery): void => {
        if (!cardLog) return
        try {
          appendAskStart(cardLog, info)
        } catch (error) {
          console.warn('[dsh-advisor-group] 跨会话卡片（开始）写入失败：', error)
        }
      }
      const onSettled = (info: AskCardSettle): void => {
        if (!cardLog) return
        try {
          appendAskAnswer(cardLog, info)
        } catch (error) {
          console.warn('[dsh-advisor-group] 跨会话卡片（结束）写入失败：', error)
        }
      }

      const value = (await askSession(ctx, exec.signal, {
        onDelivered,
        onSettled,
        currentSessionId: sessionId,
        senderName,
        currentEvents: readCurrentEvents(session),
        target: typeof args.target === 'string' ? args.target : '',
        question,
        context,
        waitMs: args.waitMs,
        detach: args.detach === true,
        log: (message) => console.log(`[dsh-advisor-group] ask_session: ${message}`),
      })) as Record<string, unknown>

      if (value.ok !== true) {
        return {
          ok: false,
          error: String(value.error ?? 'delivery-failed'),
          message: String(value.message ?? ''),
          ...(Array.isArray(value.candidates) ? { candidates: value.candidates } : {}),
          answer: '',
          note: '',
          interval: errorInterval(),
        }
      }
      return {
        ok: true,
        target: value.target as { sessionId: string; name: string },
        delivered: value.delivered as 'native' | 'fallback',
        askId: String(value.askId ?? ''),
        interval: value.interval as {
          from: string
          to: string | null
          endedBecause: 'idle' | 'timeout' | 'error' | 'detached'
        },
        answer: String(value.answer ?? ''),
        ...(value.detached === true ? { detached: true } : {}),
        ...(value.reply === null || typeof value.reply !== 'object'
          ? {}
          : { reply: value.reply as AskReply }),
        note: String(value.note ?? ''),
      }
    },
  })

  /**
   * Session roster: the read-only map the model needs before it can hand work
   * to a peer. Titles come from the host's `title` projection (the name the
   * session list shows), so no session-id hunting is required.
   */
  const listSessionsTool = defineTool({
    name: 'list_sessions',
    description:
      'List the sessions this host knows: the title shown in the session list, its sessionId, working directory, how long ago it was active, and whether it is running. Use it when the user names a session but you are unsure which one they mean, or after ask_session returns target-not-found / target-ambiguous — show the rows to the user instead of digging session ids out of log files. Read-only: it never wakes a session and costs no model call.',
    parameters: {
      query: {
        type: 'string',
        description:
          'Optional case-insensitive filter over the session title, its working directory, or its activity hint. Empty lists the most recent sessions (running first).',
      },
      limit: {
        type: 'number',
        description: 'Maximum rows (default 30, clamped to 1–50).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          count: { type: 'number', required: true },
          sessions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string', required: true },
                name: { type: 'string', required: true },
                cwd: { type: 'string' },
                updatedAt: { type: 'number', required: true },
                running: { type: 'boolean', required: true },
                subagent: { type: 'boolean', required: true },
                hint: { type: 'string', required: true },
              },
            },
          },
          error: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (args, value) =>
        value.ok === true
          ? [
              {
                type: 'text',
                text: renderRoster(value.sessions as RosterRow[], {
                  filtered: String(args.query ?? '').trim().length > 0,
                }),
              },
            ]
          : [
              {
                type: 'text',
                text: `【list_sessions 失败：${String(value.error ?? 'unknown')}】\n${String(value.message ?? '')}`,
              },
            ],
    },
    async execute(args, exec) {
      const controller = getSessionController(ctx)
      if (controller === undefined) {
        return {
          ok: false,
          count: 0,
          sessions: [],
          error: 'service-missing',
          message: '宿主没有提供 sessionController，无法列出会话。',
        }
      }
      try {
        const listed = await controller.list({}, exec.signal)
        const rows = buildSessionRoster(listed.items, {
          query: typeof args.query === 'string' ? args.query : '',
          limit: typeof args.limit === 'number' ? args.limit : undefined,
        })
        return { ok: true, count: rows.length, sessions: rows }
      } catch (error) {
        return {
          ok: false,
          count: 0,
          sessions: [],
          error: 'list-failed',
          message: String(error instanceof Error ? error.message : error),
        }
      }
    },
  })

  /** Read back a detached ask (detach: true) — the async half of the pair. */
  const askResultTool = defineTool({
    name: 'ask_result',
    description:
      "Read the result of a detached ask_session (called with detach: true). Pass askId for one result, or omit it to list this session's recent asks. States: waiting (the peer is still working — this is NOT a failure and NOT a reason to ask again; the send was already durable), done (answer ready), timeout (the wait window ended; a partial answer may exist), error. Read-only: it never wakes the target.",
    parameters: {
      askId: {
        type: 'string',
        description:
          'The askId returned by ask_session with detach: true. Omit it to list the recent asks this session started.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          count: { type: 'number', required: true },
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                askId: { type: 'string', required: true },
                sessionId: { type: 'string' },
                targetSessionId: { type: 'string' },
                from: { type: 'string' },
                status: { type: 'string', enum: ['ok', 'partial', 'failed'] },
                targetName: { type: 'string', required: true },
                question: { type: 'string', required: true },
                state: { type: 'string', required: true },
                createdAt: { type: 'number', required: true },
                settledAt: { type: 'number' },
                answer: { type: 'string' },
                reply: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    conclusion: { type: 'string' },
                    basis: { type: 'string' },
                    uncertainty: { type: 'string' },
                  },
                },
                note: { type: 'string' },
                error: { type: 'string' },
              },
            },
          },
          error: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.ok !== true) {
          return [
            {
              type: 'text',
              text: `【ask_result 失败：${String(value.error ?? 'unknown')}】\n${String(value.message ?? '')}`,
            },
          ]
        }
        const rows = Array.isArray(value.results) ? (value.results as AskRecord[]) : []
        if (rows.length === 0) return [{ type: 'text', text: '没有找到异步提问的结果。' }]
        return [{ type: 'text', text: renderAskRecords(rows) }]
      },
    },
    async execute(args, exec) {
      const session = getCurrentSessionFrom(exec)
      const sessionId = typeof session?.id === 'string' ? session.id : ''
      try {
        const dir = askStoreRoot()
        const askId = typeof args.askId === 'string' ? args.askId.trim() : ''
        const results =
          askId.length > 0
            ? [readAskRecord(dir, askId)].filter((row): row is AskRecord => row !== undefined)
            : listAskRecords(dir, sessionId.length > 0 ? { sessionId } : undefined).slice(0, 20)
        return { ok: true, count: results.length, results }
      } catch (error) {
        return {
          ok: false,
          count: 0,
          results: [],
          error: 'store-failed',
          message: String(error instanceof Error ? error.message : error),
        }
      }
    },
  })

  return [askAdvisors, toggleAdvisorGroup, askSessionTool, listSessionsTool, askResultTool]
}

/** One compact block per detached ask result, for the model to read. */
function renderAskRecords(rows: readonly AskRecord[]): string {
  const stateLabel: Record<AskRecord['state'], string> = {
    waiting: '等待中',
    done: '已完成',
    timeout: '超时',
    error: '出错',
  }
  return rows
    .map((row) => {
      const head = `- [${stateLabel[row.state]}] ${row.targetName} · askId=${row.askId}`
      const question = `  问题：${row.question.replace(/\s+/gu, ' ').slice(0, 120)}`
      const body =
        row.reply !== undefined
          ? [
              row.reply.conclusion === undefined ? '' : `  结论：${row.reply.conclusion}`,
              row.reply.basis === undefined ? '' : `  依据：${row.reply.basis}`,
              row.reply.uncertainty === undefined ? '' : `  不确定：${row.reply.uncertainty}`,
            ]
              .filter((line) => line.length > 0)
              .join('\n')
          : row.answer !== undefined && row.answer.length > 0
            ? `  ${row.answer.slice(0, 600)}`
            : row.error !== undefined
              ? `  错误：${row.error}`
              : ''
      return [head, question, body].filter((line) => line.length > 0).join('\n')
    })
    .join('\n\n')
}

/**
 * Current session id from the tool execution context. `exec.agent.session` is
 * the Agent on whose behalf the call runs (same access `ask_advisors` uses for
 * `exec.agent?.session`); the fallback covers hosts that only expose a raw
 * session object on the execution input.
 */
function getCurrentSessionFrom(exec: unknown): Session | undefined {
  return (exec as { readonly session?: Session } | undefined)?.session
}

/** Read this session's own log for the inbound-source / hop guard; empty on failure. */
function readCurrentEvents(session: Session | undefined): readonly CrossSessionLogEvent[] {
  try {
    return (session?.snapshotEvents() as readonly CrossSessionLogEvent[] | undefined) ?? []
  } catch {
    return []
  }
}

/** Empty interval carried on every not-ok result (no reply window ever opened). */
function errorInterval(): { from: string; endedBecause: 'error' } {
  return { from: new Date().toISOString(), endedBecause: 'error' }
}

// Delivery-tension ruling (2026-09-26): risk notes must actually reach the main
// model — append the structured risk notes to BOTH assembly sites (new
// consultation and follow-up) whenever present. (The keyword-derived caution
// note was removed 2026-09-29; the remaining notes are fact-based: truncation
// and cancellation flags, see risk-notes.ts.)
function formatRiskNotes(summary: ConsultSummary): string {
  return summary.riskNotes.length > 0 ? `\n\n【风险提示】\n${summary.riskNotes.join('\n')}` : ''
}

function formatConversation(session: ConsultSession): string {
  const lines = [
    `顾问群对话（session: ${session.id}）`,
    '',
  ]

  for (const message of session.messages) {
    if (message.role === 'system') continue
    if (message.role === 'main') {
      lines.push(`主模型：${message.content}`)
    } else if (message.role === 'advisor') {
      const truncatedNote =
        message.truncated === undefined
          ? ''
          : `（顾问输出在流式过程中被截断：${message.truncated.reason === 'timeout' ? '超时' : '网络中断'}，正文可能不完整）\n`
      const toolNote =
        message.toolSteps && message.toolSteps.length > 0
          ? `${message.toolSteps
              .map((step) => (step.kind === 'call' ? `  ⛭ 调用 ${step.name} · ${step.text}` : `  ↳ ${step.text}`))
              .join('\n')}\n`
          : ''
      const body =
        message.content && message.content.trim()
          ? truncatedNote + toolNote + message.content
          : truncatedNote + toolNote + (message.thinking && message.thinking.trim()
            ? `（思维链）\n${message.thinking}`
            : '（顾问未返回正文）')
      lines.push(`【${message.advisorName ?? message.advisorId ?? '顾问'}】：${body}`)
    }
    lines.push('')
  }

  const stopNote =
    session.status === 'cancelled' && session.stopReason
      ? `（注意：本次咨询被中断（${STOP_REASON_TEXT[session.stopReason] ?? session.stopReason}）；可在对话卡片点击「▶ 继续聊天」从断点续跑。）`
      : ''
  lines.push(stopNote)
  lines.push('（以上是顾问模型与主模型的对话记录，主模型可直接基于其中内容继续思考或追问。）')
  return lines.join('\n')
}

const STOP_REASON_TEXT: Record<string, string> = {
  'user-stop': '用户主动停止',
  'exec-cancel': '宿主取消',
  'abort-error': '流异常中断',
  timeout: '顾问响应超时',
  network: '网络中断',
}
