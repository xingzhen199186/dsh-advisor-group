import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { ConsultSession } from './types'
import { withTimeout } from './providers/timeout'

/**
 * The "driver model": a small internal client that reuses the CURRENT agent's
 * configured provider/model (read from the session's latest `request/header`
 * LlmCallConfig) to (a) deepen the consultation between rounds and (b) write
 * the final conclusion. If no header exists and no `discussion.driverModel`
 * fallback is configured, a static fallback text is used so the pipeline never
 * stalls. Any generation error degrades to the fallback text, never throws.
 */

export const FALLBACK_DEEPEN_QUESTION =
  '请基于以上全部讨论，针对仍然存在的分歧、未验证的假设与主要风险，提出一个有深度的后续问题。'

export const FALLBACK_CONCLUSION =
  '（⚠ 驱动模型未能生成综合结论：请主模型以上述顾问讨论为基础，自行总结共识、分歧与最可靠的行动建议。）'

export const DRIVER_SYSTEM_PROMPT = `
你是顾问群的主持人（驱动模型）。你的职责：
1. 阅读项目背景、主模型问题与全部顾问回答；
2. 提出一个更深入、聚焦的追问，推动讨论走向更细的根因、分歧或行动方案；
3. 只输出追问本身（一句话，不超过 80 字），不要回答、不要打招呼、不要解释。
`

export const CONCLUSION_SYSTEM_PROMPT = `
你是顾问群的主持人（驱动模型）。请综合全部讨论，输出最终结论：
- 用 3 段以内：共识、关键分歧（简要列出）、最可靠的行动建议；
- 不要复述每个顾问的完整回答，只提炼差异与要点。
`

export interface DriverSource {
  provider: string
  model: string
}

/** Resolve the current agent's model config from the session header, or the config fallback. */
export function resolveDriverSource(
  sessionLog: Session | undefined,
  driverModel?: { provider: string; model: string },
): DriverSource | undefined {
  if (sessionLog) {
    try {
      const header = sessionLog.requestHeader()
      if (header?.config?.provider && header?.config?.model) {
        return { provider: header.config.provider, model: header.config.model }
      }
    } catch {
      // Fall through to the configured driver model.
    }
  }
  if (driverModel?.provider && driverModel?.model) return { provider: driverModel.provider, model: driverModel.model }
  return undefined
}

function transcriptOf(session: ConsultSession): string {
  return session.messages
    .filter((message) => message.role !== 'system')
    .map((message) => {
      const speaker =
        message.role === 'main' ? '主模型' : message.advisorName ?? message.advisorId ?? '顾问'
      return `[${speaker}]\n${message.content}`
    })
    .join('\n\n')
    .slice(-24_000)
}

async function generateWith(
  ctx: Context,
  source: DriverSource,
  system: string,
  prompt: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const options: GenerateOptions = {
      provider: source.provider,
      model: source.model,
      system,
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'plugin', plugin: 'dsh-advisor-group' },
        }),
      ],
      temperature: 0.7,
      maxTokens: 600,
      signal: withTimeout(60_000, signal),
    }
    let text = ''
    for await (const chunk of ctx.llm.stream(options)) {
      if (chunk.type === 'text-delta') text += chunk.text
    }
    return text.trim() || undefined
  } catch (error) {
    // A caller abort (stop / host signal) must PROPAGATE as cancellation: the
    // follow-up was never really generated, so nothing should be pushed and a
    // resume must regenerate it fresh. Only REAL failures (timeout / provider
    // errors) degrade to the static fallback text.
    if (signal?.aborted) throw error
    return undefined
  }
}

/** One deepening question for the next round (never throws; returns fallback text). */
export async function generateDeepenQuestion(
  ctx: Context,
  session: ConsultSession,
  source: DriverSource | undefined,
  signal?: AbortSignal,
): Promise<string> {
  if (!source) return FALLBACK_DEEPEN_QUESTION
  const produced = await generateWith(
    ctx,
    source,
    DRIVER_SYSTEM_PROMPT,
    `以下是一轮顾问群的讨论记录：\n\n${transcriptOf(session)}\n\n请给出下一步的深入追问。`,
    signal,
  )
  return produced || FALLBACK_DEEPEN_QUESTION
}

/** Final synthesis after all rounds (never throws; returns fallback text). */
export async function generateConclusion(
  ctx: Context,
  session: ConsultSession,
  source: DriverSource | undefined,
  signal?: AbortSignal,
): Promise<string> {
  if (!source) return FALLBACK_CONCLUSION
  const produced = await generateWith(
    ctx,
    source,
    CONCLUSION_SYSTEM_PROMPT,
    `以下是顾问群全部 ${session.messages.filter((m) => m.role === 'advisor').length} 条顾问回答的讨论记录：\n\n${transcriptOf(session)}\n\n请给出综合结论。`,
    signal,
  )
  return produced || FALLBACK_CONCLUSION
}
