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

/** The effective endpoint for a Jev config. */
function jevEndpointOf(config: JevConfig): string {
  return config.baseURL?.trim() || DEFAULT_ENDPOINTS[config.provider]
}

/** The effective API key: the configured env var first, then the stored key. */
function jevApiKeyOf(config: JevConfig): string | undefined {
  const storedKey = typeof config.apiKey === 'string'
    ? config.apiKey
    : config.apiKey && typeof config.apiKey === 'object' && 'value' in config.apiKey
      ? String((config.apiKey as unknown as { value: unknown }).value ?? '')
      : undefined
  return (config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined) || storedKey
}

/**
 * True when Jev can actually be called: a config exists and resolves to a
 * non-empty API key. The routing engine uses this to tell "not configured"
 * (local order plus a note) from "configured but failed" (silent fallback).
 */
export function jevConfigured(config: JevConfig | undefined): boolean {
  if (config === undefined || config === null || typeof config !== 'object') return false
  const key = jevApiKeyOf(config)
  return key !== undefined && key.length > 0
}

/**
 * POST one serialised payload to the configured Jev endpoint. Timeout and the
 * caller's abort signal are handled once, here, for every request shape.
 */
async function postJev(config: JevConfig, payload: string, signal?: AbortSignal): Promise<unknown> {
  const endpoint = jevEndpointOf(config)
  const apiKey = jevApiKeyOf(config)
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
      body: payload,
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`Jev HTTP ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
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
  const body = await postJev(
    config,
    JSON.stringify({
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
    signal,
  )
  return parseResponse(body, config, advisors)
}

/** The escape option: Jev says none of the listed candidates is the target. */
export const JEV_NONE_OPTION = 'none'

/** One closed-set routing option handed to Jev; `id` is the answer key (a session id). */
export interface JevRouteOption {
  id: string
  /** Display title, kept in its original language (never translated). */
  title: string
  /** Optional one-line scope note, kept in its original language. */
  scope?: string
}

/** Jev's answer to the closed-set routing question. */
export interface JevRouteDecision {
  /** The chosen option id as returned (a session id, or {@link JEV_NONE_OPTION}). */
  choice: string
  /** Confidence in [0,1]: the explicit `confidence`, else the chosen option's probability. */
  confidence?: number
  /** Per-option probabilities, when the response provides them. */
  probabilities?: Record<string, number>
  /** Model id actually reported by the response. */
  model?: string
}

/** Finite numbers only, keyed by option id; undefined when nothing usable is left. */
function numberMap(value: unknown): Record<string, number> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, number> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const number = numberValue(raw)
    if (number !== undefined) out[key] = number
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * Read one closed-set routing answer. Throws on anything unparseable (no
 * answers, no route answer, no usable choice) so the router keeps the local
 * order instead of acting on a guess.
 */
function parseRouteResponse(body: unknown): JevRouteDecision {
  if (!body || typeof body !== 'object') throw new Error('Jev 响应不是对象')
  const answers = (body as JevResponse).answers
  if (!answers || typeof answers !== 'object') throw new Error('Jev 响应缺少 answers')
  const answer = answers.route as JevAnswer | undefined
  if (answer === null || typeof answer !== 'object') throw new Error('Jev 响应缺少 route 判定')
  const choice = typeof answer.choice === 'string' ? answer.choice.trim() : ''
  if (choice.length === 0) throw new Error('Jev 响应缺少 route.choice')
  // Explicit confidence wins; otherwise the chosen option's probability, then
  // the largest probability in the answer.
  const probabilities = numberMap(answer.probabilities)
  const confidence =
    numberValue(answer.confidence) ??
    probabilities?.[choice] ??
    (probabilities === undefined ? undefined : Math.max(...Object.values(probabilities)))
  const reportedModel = (body as JevResponse).model
  return {
    choice,
    ...(confidence === undefined ? {} : { confidence }),
    ...(probabilities === undefined ? {} : { probabilities }),
    ...(typeof reportedModel === 'string' ? { model: reportedModel } : {}),
  }
}

/** Closed-set criteria for the candidates: id → `title — scope`, plus the escape. */
function optionCriteria(options: readonly JevRouteOption[], noneText: string): Record<string, string> {
  const criteria: Record<string, string> = {}
  for (const option of options) {
    const id = typeof option.id === 'string' ? option.id.trim() : ''
    if (id.length === 0) continue
    const title = typeof option.title === 'string' ? option.title.trim() : ''
    const scope = typeof option.scope === 'string' ? option.scope.trim() : ''
    criteria[id] = scope.length > 0 ? `${title} — ${scope}` : title
  }
  criteria[JEV_NONE_OPTION] = noneText
  return criteria
}

/**
 * Ask Jev which routed candidate is the best target: one closed-set `choice`
 * question, English instructions, an explicit `none` escape, and the
 * candidates' own titles/scopes kept in their original language.
 *
 * Rejects (never resolves to a guess) on a missing key, an empty option list,
 * any transport/HTTP failure, or a malformed response; the router treats every
 * rejection as "keep the local order".
 */
export async function routeWithJev(
  question: string,
  questionEn: string | undefined,
  options: readonly JevRouteOption[],
  config: JevConfig,
  signal?: AbortSignal,
): Promise<JevRouteDecision> {
  if (!jevConfigured(config)) throw new Error('Jev 未配置 API key')
  if (!Array.isArray(options) || options.length === 0) throw new Error('Jev 路由没有候选可判断')
  const criteria = optionCriteria(options, 'None of the listed sessions is the right target for this question.')
  const gloss = typeof questionEn === 'string' ? questionEn.trim() : ''
  const state = [
    'A user asked a question and wants it sent to exactly one existing session. Choose the option whose session is the best target for that question.',
    gloss.length > 0 ? `English gloss of the question: ${gloss}` : undefined,
    `Question (verbatim, may be Chinese): ${question}`,
  ].filter((line): line is string => line !== undefined).join('\n')
  const body = await postJev(
    config,
    JSON.stringify({
      state,
      model: config.model || 'jev-latest',
      questions: {
        route: {
          type: 'choice',
          instructions:
            'Pick exactly one option: the session this question should be sent to. Pick none when no listed session fits.',
          criteria,
        },
      },
    }),
    signal,
  )
  return parseRouteResponse(body)
}

// ---------------------------------------------------------------------------
// Cross-session suggestion (2026-10-19): one batched request, three answers.
// ---------------------------------------------------------------------------

/** Jev's batched cross-session judgment, reduced to the facts the caller reads. */
export interface JevCrossSessionJudgment {
  /** `ask` confidence in [0,1] (explicit `confidence`, else `noul`). */
  askConfidence?: number
  /** Chosen candidate id (a session id or {@link JEV_NONE_OPTION}), when a pick question ran. */
  pick?: string
  /** `pick` confidence in [0,1] (explicit → chosen option probability → max probability). */
  pickConfidence?: number
  /** `sensitive` confidence in [0,1] (explicit `confidence`, else `noul`). */
  sensitiveConfidence?: number
  /** Model id actually reported by the response. */
  model?: string
}

/** A noul answer's confidence: the explicit `confidence`, else the `noul` value. */
function noulConfidence(answer: JevAnswer | undefined): number | undefined {
  return numberValue(answer?.confidence) ?? numberValue(answer?.noul)
}

/** Read one batched judgment; throws unless `ask` and `sensitive` are usable. */
function parseCrossSessionResponse(body: unknown): JevCrossSessionJudgment {
  if (!body || typeof body !== 'object') throw new Error('Jev 响应不是对象')
  const answers = (body as JevResponse).answers
  if (!answers || typeof answers !== 'object') throw new Error('Jev 响应缺少 answers')
  const askConfidence = noulConfidence(answers.ask)
  if (askConfidence === undefined) throw new Error('Jev 响应缺少 ask 的有效判定')
  const sensitiveConfidence = noulConfidence(answers.sensitive)
  if (sensitiveConfidence === undefined) throw new Error('Jev 响应缺少 sensitive 的有效判定')
  const pickAnswer = answers.pick as JevAnswer | undefined
  const pick =
    pickAnswer !== null && typeof pickAnswer === 'object' && typeof pickAnswer.choice === 'string'
      ? pickAnswer.choice.trim()
      : ''
  const probabilities =
    pickAnswer !== null && typeof pickAnswer === 'object' ? numberMap(pickAnswer.probabilities) : undefined
  const pickConfidence =
    pick.length === 0
      ? undefined
      : numberValue(pickAnswer?.confidence) ??
        probabilities?.[pick] ??
        (probabilities === undefined ? undefined : Math.max(...Object.values(probabilities)))
  const reportedModel = (body as JevResponse).model
  return {
    askConfidence,
    sensitiveConfidence,
    ...(pick.length === 0 ? {} : { pick }),
    ...(pickConfidence === undefined ? {} : { pickConfidence }),
    ...(typeof reportedModel === 'string' ? { model: reportedModel } : {}),
  }
}

/**
 * One batched judgment for the cross-session suggestion: `ask` (noul), `pick`
 * (choice, present only when there are candidates) and `sensitive` (noul) all
 * travel in a single request, so one hint costs one call. English
 * instructions; candidate titles/scopes stay in their original language.
 *
 * Throws when the response is missing or its ask/sensitive answers are
 * unusable; the caller treats that as "no hint".
 */
export async function judgeCrossSessionWithJev(
  text: string,
  textEn: string | undefined,
  candidates: readonly JevRouteOption[],
  config: JevConfig,
  signal?: AbortSignal,
): Promise<JevCrossSessionJudgment> {
  if (!jevConfigured(config)) throw new Error('Jev 未配置 API key')
  const options = Array.isArray(candidates) ? candidates : []
  const questions: Record<string, unknown> = {
    ask: {
      type: 'noul',
      instructions: 'Should answering this turn consult another existing session of the same user?',
      criteria: {
        true: {
          what: 'The turn depends on facts that live in another session: the state, progress, recent changes, or version of a project or task that session has been working on.',
          examples: [
            'asking for the current progress or status of work started elsewhere',
            'asking what a different session decided, changed, or last talked about',
            'continuing a task whose details were only ever discussed in another session',
          ],
        },
        false: {
          what: 'The turn can be answered from this session alone, from general knowledge, or does not depend on any other session.',
          examples: [
            'self-contained coding or writing requests',
            'general questions and opinions',
            'questions about this very session only',
          ],
        },
      },
    },
    sensitive: {
      type: 'noul',
      instructions: 'Is this turn private or sensitive enough that it must not be routed to another session automatically?',
      criteria: {
        true: {
          what: 'The content carries secrets or personal or confidential material that should not leave this session on its own.',
          examples: [
            'credentials, API keys, tokens, passwords, or private keys',
            'personal, medical, legal, or financial details about a person',
            'content the user marked private, confidential, or off the record',
          ],
        },
        false: {
          what: 'Ordinary project, technical, or general questions with nothing private in them.',
          examples: [
            'code, build, and repository questions',
            'general knowledge or everyday planning',
          ],
        },
      },
    },
  }
  if (options.length > 0) {
    questions.pick = {
      type: 'choice',
      instructions:
        'Which of these sessions is the best one to ask about this turn? Pick none when none of them fits.',
      criteria: optionCriteria(options, 'None of the listed sessions is the right target for this turn.'),
    }
  }
  const gloss = typeof textEn === 'string' ? textEn.trim() : ''
  const state = [
    'A user turn arrived in one session of a coding agent. Judge that turn for the three questions in this request.',
    gloss.length > 0 ? `English gloss of the turn: ${gloss}` : undefined,
    `Turn (verbatim, may be Chinese): ${text}`,
  ].filter((line): line is string => line !== undefined).join('\n')
  const body = await postJev(
    config,
    JSON.stringify({
      state,
      model: config.model || 'jev-latest',
      questions,
    }),
    signal,
  )
  return parseCrossSessionResponse(body)
}
