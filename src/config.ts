import Schema from '@deepseek-ai/schemastery'
import { DEFAULT_ADVISOR_PROMPT } from './defaults'

export type ProviderProtocol = 'openai' | 'anthropic' | 'gemini'
export type ProviderAuthMode = 'x-api-key' | 'bearer'

export interface AdvisorConfig {
  id: string
  name: string
  avatar?: string
  provider: string
  model: string
  systemPrompt: string
  temperature?: number
  maxTokens?: number
  baseURL?: string
  apiKey?: string
  apiKeyEnv?: string
  protocol?: ProviderProtocol
  authMode?: ProviderAuthMode
  /**
   * Server-side per-provider direct-key history for one advisor.
   * Keys are never returned to the browser; they let a user switch back to a
   * previously used provider without losing that provider's API key.
   */
  apiKeysByProvider?: Record<string, string>
  /**
   * Client→server only: an explicit "clear the current provider's key" intent
   * (SecretField semantics — an empty apiKey now means "keep the stored key").
   * Stripped before persistence and never returned to the browser.
   */
  clearApiKey?: boolean
  /**
   * Server→client only: per-provider key presence facts (no key material).
   * Derived by `sanitizeConfig`; never persisted and never sent by the client.
   */
  apiKeyMetaByProvider?: Record<string, { configured: boolean; last4?: string }>
}

export interface DiscussionConfig {
  maxRounds: number
  maxAdvisorsPerCall: number
  /**
   * Deprecated (2026-09-05): rounds are now a sequential A → B → C relay,
   * advisors are never invoked in parallel. Kept for stored-config
   * compatibility only.
   */
  parallel: boolean
  /**
   * Auto-deepen pipeline (2026-09-05): when true, the consultation runs up to
   * `maxRounds` rounds automatically — after each round the driver model
   * (the current agent's provider/model) asks a deeper follow-up, and a final
   * synthesis closes the consultation.
   */
  autoDeepen: boolean
  /**
   * Fallback driver model used when the session header cannot be read
   * (e.g. resumed sessions without a request/header event).
   */
  driverModel?: { provider: string; model: string }
  /**
   * Deprecated (2026-09-05): the auto-deepen pipeline made this dormant.
   * Kept in the schema only for stored-config compatibility;
   * no longer rendered in the settings card.
   */
  stopOnConsensus: boolean
  /**
   * Per-advisor call timeout in milliseconds (default 120000 = 2 min).
   * Applied to both the ctx.llm and direct-http channels.
   */
  advisorTimeoutMs?: number
}

export interface TriggerConfig {
  requireClassifier: boolean
  allowWebFallback: boolean
  confidenceThreshold: number
}

export interface UiConfig {
  theme: 'retro-green' | 'retro-amber' | 'retro-blue'
  showTimestamps: boolean
  autoExpand: boolean
}

export interface QuotaConfig {
  /** Enable the per-UTC-day new-consultation cap (cost safety valve). */
  enabled: boolean
  /** Max new consultations per UTC day when enabled (1–100000), default 50. */
  maxPerDay: number
}

export interface Config {
  enabled: boolean
  discussion: DiscussionConfig
  trigger: TriggerConfig
  ui: UiConfig
  quota: QuotaConfig
  advisors: AdvisorConfig[]
}

const ProviderProtocol = Schema.union([
  Schema.const('openai'),
  Schema.const('anthropic'),
  Schema.const('gemini'),
])

const ProviderAuthMode = Schema.union([
  Schema.const('x-api-key'),
  Schema.const('bearer'),
])

const AdvisorConfig: Schema<AdvisorConfig> = Schema.object({
  id: Schema.string().required().description('Unique advisor id used by ask_advisors.'),
  name: Schema.string().required().description('Display name shown in the chat group.'),
  avatar: Schema.string().description('Short emoji or ASCII avatar.'),
  provider: Schema.string().required().description('Provider route passed to ctx.llm, e.g. deepseek-official or openai.'),
  model: Schema.string().required().description('Model id on that provider route.'),
  systemPrompt: Schema.string().default(DEFAULT_ADVISOR_PROMPT),
  temperature: Schema.number().min(0).max(2),
  maxTokens: Schema.number().min(1),
  baseURL: Schema.string().description('Optional direct-http fallback base URL.'),
  apiKey: Schema.string().role('secret').description('Direct API key used for direct-http fallback. Stored in local config; prefer apiKeyEnv if you do not want the key in settings.yaml.'),
  apiKeysByProvider: Schema.dict(Schema.string()).role('secret').default({}).description('Server-side per-provider key history; never returned to the browser. Marked secret so the official settings redaction (describe) never sends it over any wire.'),
  clearApiKey: Schema.boolean().description('Transient client intent: clear the current provider direct key. Stripped before persistence.'),
  apiKeyEnv: Schema.string().description('Optional env var name for direct-http fallback.'),
  protocol: ProviderProtocol,
  authMode: ProviderAuthMode.description('Anthropic auth header style: x-api-key or bearer.'),
})

const DriverModel: Schema<{ provider: string; model: string }> = Schema.object({
  provider: Schema.string().required().description('Provider route of the fallback driver model.'),
  model: Schema.string().required().description('Model id of the fallback driver model.'),
})

const DiscussionConfig: Schema<DiscussionConfig> = Schema.object({
  maxRounds: Schema.natural().min(1).max(5).default(2).description('Total rounds of the auto-deepen consultation (each round = driver deep-question + all advisors in relay order).'),
  maxAdvisorsPerCall: Schema.natural().min(1).max(10).default(3).description('Maximum number of advisors consulted in one ask_advisors call.'),
  parallel: Schema.boolean().default(true).description('Deprecated: rounds are a sequential A→B→C relay; kept for stored-config compatibility.'),
  autoDeepen: Schema.boolean().default(true).description('Run the auto-deepen pipeline: after each round the driver model asks a deeper follow-up, and a final conclusion closes the consultation.'),
  driverModel: Schema.union([DriverModel, Schema.const(undefined)]).description('Fallback driver model (provider/model) used when the session header cannot be read.'),
  stopOnConsensus: Schema.boolean().default(false).description('Deprecated: dormant under the auto-deepen pipeline; kept for stored-config compatibility.'),
  advisorTimeoutMs: Schema.number().min(1000).max(600000).default(120000).description('Per-advisor call timeout in milliseconds (default 120000).'),
})

const TriggerConfig: Schema<TriggerConfig> = Schema.object({
  requireClassifier: Schema.boolean().default(true).description('Run the pre-classifier before starting a consultation.'),
  allowWebFallback: Schema.boolean().default(true).description('When classifier says web search is better, return that hint to the main model.'),
  confidenceThreshold: Schema.number().min(0).max(1).default(0.6).description('Below this confidence score, ask_advisors should escalate even without domain keywords.'),
})

const UiConfig: Schema<UiConfig> = Schema.object({
  theme: Schema.union([
    Schema.const('retro-green'),
    Schema.const('retro-amber'),
    Schema.const('retro-blue'),
  ]).default('retro-green'),
  showTimestamps: Schema.boolean().default(true),
  autoExpand: Schema.boolean().default(true),
})

const QuotaConfig: Schema<QuotaConfig> = Schema.object({
  enabled: Schema.boolean().default(true).description('Enable the daily new-consultation cap (cost safety valve).'),
  maxPerDay: Schema.natural().min(1).max(100000).default(50).description('Max new consultations per UTC day (1–100000); ignored when enabled is false.'),
})

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true),
  discussion: DiscussionConfig,
  trigger: TriggerConfig,
  ui: UiConfig,
  quota: QuotaConfig,
  advisors: Schema.array(AdvisorConfig).default([]),
})
