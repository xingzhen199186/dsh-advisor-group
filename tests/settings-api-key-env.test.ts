import { describe, expect, it } from 'vitest'
import { allowedApiKeyEnvs, validateSecurity } from '../src/settings-api'
import type { Config, AdvisorConfig } from '../src/config'

function advisor(overrides: Partial<AdvisorConfig> = {}): AdvisorConfig {
  return {
    id: 'advisor-a',
    name: '顾问A',
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    systemPrompt: '你是资深专家。',
    ...overrides,
  }
}

function config(advisors: AdvisorConfig[], jevApiKeyEnv?: string): Config {
  return {
    enabled: true,
    discussion: { maxRounds: 2, maxAdvisorsPerCall: 3, parallel: true, autoDeepen: true, stopOnConsensus: false },
    trigger: {
      requireClassifier: true,
      allowWebFallback: true,
      confidenceThreshold: 0.6,
      ...(jevApiKeyEnv === undefined ? {} : { jev: { apiKeyEnv: jevApiKeyEnv } }),
    },
    ui: { theme: 'retro-green', showTimestamps: true, autoExpand: true },
    quota: { enabled: true, maxPerDay: 50 },
    advisors,
  } as unknown as Config
}

/**
 * A custom provider's own variable name must work — that was the 2026-10-18 report
 * (「API Key 不能使用该环境变量名」). The guard stays meaningful because the allowed
 * set is the presets' names plus names the user has *saved*: a caller can never
 * invent one, so the diagnostics still cannot read arbitrary environment variables.
 */
describe('API key environment names (custom providers)', () => {
  it('allows the names the presets declare', () => {
    const allowed = allowedApiKeyEnvs(config([advisor()]))
    expect(allowed.has('DEEPSEEK_API_KEY')).toBe(true)
    expect(allowed.has('OPENROUTER_API_KEY')).toBe(true)
  })

  it('allows a custom name once it is saved, and only then', () => {
    const saved = allowedApiKeyEnvs(config([advisor({ provider: 'my-custom', apiKeyEnv: 'MY_CUSTOM_KEY' })]))
    expect(saved.has('MY_CUSTOM_KEY')).toBe(true)

    const unsaved = allowedApiKeyEnvs(config([advisor({ provider: 'my-custom' })]))
    expect(unsaved.has('MY_CUSTOM_KEY')).toBe(false)
    expect(unsaved.has('AWS_SECRET_ACCESS_KEY')).toBe(false)
  })

  it('includes the Jev variable', () => {
    expect(allowedApiKeyEnvs(config([advisor()], 'MY_JEV_KEY')).has('MY_JEV_KEY')).toBe(true)
  })

  it('accepts a custom provider with its own variable at save time', () => {
    expect(
      validateSecurity(
        config([
          advisor({ provider: 'my-custom', baseURL: 'https://api.example.com', apiKeyEnv: 'MY_CUSTOM_KEY' }),
        ]),
      ),
    ).toBeNull()
  })

  it('still refuses a malformed variable name', () => {
    const error = validateSecurity(config([advisor({ apiKeyEnv: 'not a name!' })]))
    expect(error).toContain('环境变量名无效')
  })

  it('still refuses a non-https diagnostic address', () => {
    expect(validateSecurity(config([advisor({ baseURL: 'http://api.example.com' })]))).toContain('仅允许')
  })
})
