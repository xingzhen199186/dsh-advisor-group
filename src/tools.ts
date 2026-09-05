import { defineTool } from '@deepseek-ai/dsh-tools'
import { advisorsMissingModel } from './model-validation'
import { appendShadowSample } from './shadow'
import { classifyRequest } from './classifier'
import type { AdvisorGroupService } from './service'
import { appendAdvisorStart } from './session-log'
import type { ConsultSession } from './types'

export function registerAdvisorTools(service: AdvisorGroupService): Array<ReturnType<typeof defineTool>> {
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
      const forcedByRepeat = (repeatPressure?.count ?? 0) >= 3

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
        if (service.hasReachedMaxRounds(session)) {
          return {
            sessionId: session.id,
            advice: '本轮已是顾问群讨论的最后一轮，请综合现有顾问意见给出最终答复，不要再追问。',
            skipped: true,
            reason: 'max-rounds-reached',
          }
        }
        service.appendFollowUp(session.id, args.followUp, sessionLog)
        await service.runOneRoundAndSummarize(session, exec.signal, sessionLog)
        const canContinue = !service.hasReachedMaxRounds(session)
        return {
          sessionId: session.id,
          advice:
            formatConversation(session) +
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
        const classification = classifyRequest(
          args.question,
          args.context,
          cfg.advisors,
          args.confidence,
          cfg.trigger.confidenceThreshold,
        )
        // Shadow sample: record every non-forced verdict for threshold tuning.
        // Fire-and-forget; never influences behavior.
        appendShadowSample({
          ts: Date.now(),
          question: args.question,
          ...(typeof args.confidence === 'number' ? { confidence: args.confidence } : {}),
          shouldEscalate: classification.shouldEscalate,
          reason: classification.reason,
          suggestWebSearch: classification.suggestWebSearch,
          launched: classification.shouldEscalate,
        })
        if (!classification.shouldEscalate) {
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
      }

      if (args.advisorIds && args.advisorIds.length > 0) {
        const configuredIds = new Set(cfg.advisors.map((advisor) => advisor.id))
        const matched = args.advisorIds.filter((id) => configuredIds.has(id))
        if (matched.length === 0) {
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
      )
      if (sessionLog) appendAdvisorStart(sessionLog, session)
      // Auto-deepen pipeline (2026-09-05): one call runs the whole consultation
      // — up to maxRounds rounds of [driver deep-question → A → B(sees A) →
      // C(sees A+B) …], closed by a driver-generated conclusion.
      const summary = await service.runAutoPipeline(session, exec.signal, sessionLog)
      return {
        sessionId: session.id,
        advice:
          formatConversation(session) +
          (summary.conclusion ? `\n\n【综合结论】\n${summary.conclusion}` : '') +
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

  return [askAdvisors, toggleAdvisorGroup]
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
      const body =
        message.content && message.content.trim()
          ? truncatedNote + message.content
          : truncatedNote + (message.thinking && message.thinking.trim()
            ? `（思维链）\n${message.thinking}`
            : '（顾问未返回正文）')
      lines.push(`【${message.advisorName ?? message.advisorId ?? '顾问'}】：${body}`)
    }
    lines.push('')
  }

  lines.push('（以上是顾问模型与主模型的对话记录，主模型可直接基于其中内容继续思考或追问。）')
  return lines.join('\n')
}
