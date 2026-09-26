import type { AdvisorConfig, JevConfig, JevProvider } from '../config'
import { matchAdvisors } from '../classifier'
import type { ClassifierResult } from '../types'

/** Raw per-question values from a Jev response; recorded for threshold calibration. */
export interface JevRawAnswers {
  /** Raw `noul` of needs_advisor, when the response provides a finite one. */
  needsAdvisor?: number
  /** Raw `noul` of web_search. */
  webSearch?: number
  /** Raw `noul` of high_risk. */
  highRisk?: number
  /** Chosen domain (Choice answer). */
  domain?: string
}

export interface JevClassificationResult extends ClassifierResult {
  provider: JevProvider
  confidence?: number
  /** Per-question raw values, consumed by the shadow log (not by behavior). */
  rawAnswers?: JevRawAnswers
  /** Model id actually reported by the response (the `jev-latest` alias can move). */
  model?: string
}

interface JevAnswer {
  type?: string
  noul?: unknown
  choice?: unknown
  probabilities?: Record<string, unknown>
  confidence?: unknown
}

interface JevResponse {
  answers?: Record<string, JevAnswer>
  model?: unknown
}

const DEFAULT_ENDPOINTS: Record<JevProvider, string> = {
  typesafe: 'https://api.typesafe.ai/v1/systemone',
  openrouter: 'https://openrouter.ai/api/alpha/decisions',
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function answerIsTrue(answer: JevAnswer | undefined, threshold: number): boolean {
  const noul = numberValue(answer?.noul)
  if (noul !== undefined) return noul >= threshold
  const choice = typeof answer?.choice === 'string' ? answer.choice.toLowerCase() : ''
  if (choice === 'yes' || choice === 'true') return true
  if (choice === 'no' || choice === 'false') return false
  return false
}

/**
 * An answer is usable only when it carries a finite noul or an explicit
 * yes/no choice. Anything else (missing key, string noul, "maybe") would be
 * read as `false` by answerIsTrue — which for needs_advisor/high_risk means a
 * silent rejection with no fallback to the local classifier.
 */
function answerUsable(answer: JevAnswer | undefined): boolean {
  if (numberValue(answer?.noul) !== undefined) return true
  const choice = typeof answer?.choice === 'string' ? answer.choice.toLowerCase() : ''
  return choice === 'yes' || choice === 'true' || choice === 'no' || choice === 'false'
}

function parseResponse(body: unknown, config: JevConfig, advisors: AdvisorConfig[]): JevClassificationResult {
  if (!body || typeof body !== 'object') throw new Error('Jev 响应不是对象')
  const answers = (body as JevResponse).answers
  if (!answers || typeof answers !== 'object') throw new Error('Jev 响应缺少 answers')

  const needsAdvisor = answers.needs_advisor
  const webSearch = answers.web_search
  const risk = answers.high_risk
  const domainAnswer = answers.domain
  // These two drive the escalate decision. An unusable value must throw so
  // tools.ts falls back to the local classifier; defaulting it to `false`
  // would reject silently, in the unsafe direction for high_risk.
  if (!answerUsable(needsAdvisor)) throw new Error('Jev 响应缺少 needs_advisor 的有效判定')
  if (!answerUsable(risk)) throw new Error('Jev 响应缺少 high_risk 的有效判定')
  const domain = typeof domainAnswer?.choice === 'string' ? domainAnswer.choice : 'general'
  const needsAdvisorNoul = numberValue(needsAdvisor?.noul)
  const confidence = numberValue(needsAdvisor?.confidence) ?? needsAdvisorNoul
  const shouldEscalate = answerIsTrue(needsAdvisor, config.confidenceThreshold)
  const suggestWebSearch = answerIsTrue(webSearch, config.confidenceThreshold)
  // high_risk gets its own threshold so it can be made more eager than the
  // general judgment (our action is conservative: a missed escalation costs
  // more than a false one); unset keeps the pre-existing shared-threshold behavior.
  const highRisk = answerIsTrue(risk, config.highRiskThreshold ?? config.confidenceThreshold)
  const reportedModel = (body as JevResponse).model
  const webSearchNoul = numberValue(webSearch?.noul)
  const riskNoul = numberValue(risk?.noul)
  const rawAnswers: JevRawAnswers = {
    ...(needsAdvisorNoul === undefined ? {} : { needsAdvisor: needsAdvisorNoul }),
    ...(webSearchNoul === undefined ? {} : { webSearch: webSearchNoul }),
    ...(riskNoul === undefined ? {} : { highRisk: riskNoul }),
    domain,
  }

  return {
    shouldEscalate: shouldEscalate || highRisk,
    suggestWebSearch: !shouldEscalate && !highRisk && suggestWebSearch,
    suggestedAdvisors: matchAdvisors(`${domain}\n${domainAnswer?.choice ?? ''}`, advisors),
    reason: highRisk
      ? 'Jev 判断该问题包含高风险因素，建议启动顾问群。'
      : shouldEscalate
        ? `Jev 判断该问题需要顾问群（${confidence === undefined ? '无置信度' : `置信度 ${confidence}`}）。`
        : suggestWebSearch
          ? 'Jev 判断该问题更适合联网搜索。'
          : 'Jev 判断该问题不需要启动顾问群。',
    ...(confidence === undefined ? {} : { confidence }),
    rawAnswers,
    ...(typeof reportedModel === 'string' ? { model: reportedModel } : {}),
    provider: config.provider,
  }
}

export async function classifyWithJev(
  question: string,
  context: string | undefined,
  advisors: AdvisorConfig[],
  config: JevConfig,
  signal?: AbortSignal,
  questionEn?: string,
): Promise<JevClassificationResult> {
  const endpoint = config.baseURL?.trim() || DEFAULT_ENDPOINTS[config.provider]
  const storedKey = typeof config.apiKey === 'string'
    ? config.apiKey
    : config.apiKey && typeof config.apiKey === 'object' && 'value' in config.apiKey
      ? String((config.apiKey as unknown as { value: unknown }).value ?? '')
      : undefined
  const apiKey = (config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined) || storedKey
  if (!apiKey) throw new Error('Jev 未配置 API key')

  const controller = new AbortController()
  // Attach a reason so a timeout surfaces as "Jev 超时" in the fallback warn
  // instead of fetch's generic "operation aborted" (which reads like a cancel).
  const timeout = setTimeout(() => controller.abort(new Error(`Jev 超时（${config.timeoutMs}ms）`)), config.timeoutMs)
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        // The optional English gist replaces the state ONLY when the settings
        // toggle is on and the caller actually supplied one; the displayed
        // question and session records keep using the Chinese original.
        state: config.useEnglishState && questionEn?.trim()
          ? questionEn.trim()
          : `${question}\n\n背景：${context || '无'}`,
        model: config.model || 'jev-latest',
        questions: {
          // One judgment per question (KB: don't hide several judgments in one
          // question); boundary detail lives in criteria, and the escalation
          // decision is the OR across needs_advisor/high_risk below.
          needs_advisor: {
            type: 'noul',
            instructions: 'Does answering this question require expert-level knowledge?',
            criteria: {
              true: {
                what: 'The subject matter is professional, specialist, or long-tail knowledge a competent generalist would not reliably get right, or the field itself has no single settled answer without specialist judgment.',
                examples: [
                  'professional-domain judgment such as accounting treatment, engineering trade-offs, or contract drafting',
                  'rare or long-tail situations with little public consensus',
                  'topics where reasonable experts disagree and picking correctly matters',
                ],
              },
              false: {
                what: 'A competent generalist can answer from common knowledge, widely documented facts, or ordinary reasoning without specialist judgment.',
                examples: [
                  'everyday facts, definitions, or casual opinions',
                  'well-documented mainstream topics with an agreed answer',
                ],
              },
            },
          },
          web_search: {
            type: 'noul',
            instructions: 'Does answering this question primarily require current, real-time, or externally verifiable information?',
            criteria: {
              true: {
                what: 'The correct answer depends on facts that change over time or live outside the provided state, so it must be looked up rather than reasoned out.',
                examples: [
                  'today’s weather, prices, exchange rates, or quotes',
                  'recent releases, news, or version-specific changelogs',
                  'local or niche facts with no authoritative source in memory',
                ],
              },
              false: {
                what: 'The answer follows from stable knowledge or reasoning already available in the state.',
                examples: [
                  'concepts, definitions, and established best practices',
                  'questions fully answerable from the provided background',
                ],
              },
            },
          },
          high_risk: {
            type: 'noul',
            instructions: 'Does this question involve medical, legal, financial, safety, compliance, or other high-risk advice?',
            criteria: {
              true: {
                what: 'A wrong or careless answer could materially harm the asker or a third party in health, money, safety, or legal standing.',
                examples: [
                  'medical symptoms, medication, diagnosis, or treatment decisions',
                  'legal rights, contracts, litigation, or regulatory compliance',
                  'investment, insurance, tax, or other money decisions with real downside',
                  'physical safety, hazardous actions, or regulated activities',
                ],
              },
              false: {
                what: 'Being wrong carries no material harm to health, money, safety, or legal standing.',
                examples: [
                  'general knowledge, opinions, or entertainment questions',
                  'technical details whose worst case is wasted time',
                ],
              },
            },
          },
          domain: {
            type: 'choice',
            instructions: 'Which domain best describes this question?',
            criteria: {
              legal: 'law, contracts, litigation, compliance, or taxation',
              medical: 'medicine, symptoms, medication, diagnosis, or treatment',
              finance: 'investment, insurance, accounting, or financial risk',
              code: 'software, programming, architecture, debugging, or APIs',
              general: 'none of the listed domains',
            },
          },
        },
      }),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`Jev HTTP ${response.status}`)
    return parseResponse(await response.json(), config, advisors)
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}
