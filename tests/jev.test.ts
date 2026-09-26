import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyWithJev } from '../src/providers/jev'
import type { AdvisorConfig, JevConfig } from '../src/config'

const advisors: AdvisorConfig[] = [
  { id: 'legal', name: '法务', provider: 'x', model: 'x', systemPrompt: '' },
]

const baseConfig: JevConfig = {
  enabled: true,
  provider: 'typesafe',
  model: 'jev-latest',
  timeoutMs: 100,
  confidenceThreshold: 0.6,
}

afterEach(() => vi.restoreAllMocks())

describe('Jev provider adapters', () => {
  it('calls TypeSafe with bearer auth and parses answers', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      model: 'typesafe/jev-1.13.0',
      answers: {
        needs_advisor: { noul: 0.9, confidence: 0.9 },
        web_search: { noul: 0.1 },
        high_risk: { noul: 0.2 },
        domain: { choice: 'legal' },
      },
    }), { status: 200 }))
    const result = await classifyWithJev('合同风险', '背景', advisors, { ...baseConfig, apiKey: 'secret' })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.typesafe.ai/v1/systemone',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer secret' }),
      }),
    )
    expect(result.shouldEscalate).toBe(true)
    expect(result.suggestedAdvisors).toEqual(['legal'])
    // Raw probabilities + reported model feed the shadow log for calibration.
    expect(result.rawAnswers).toEqual({ needsAdvisor: 0.9, webSearch: 0.1, highRisk: 0.2, domain: 'legal' })
    expect(result.model).toBe('typesafe/jev-1.13.0')
  })

  it('uses the OpenRouter Decisions endpoint and environment key', async () => {
    process.env.JEV_TEST_KEY = 'env-secret'
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      answers: { needs_advisor: { choice: 'no' }, high_risk: { choice: 'no' }, web_search: { choice: 'yes' }, domain: { choice: 'general' } },
    }), { status: 200 }))
    const result = await classifyWithJev('天气', undefined, advisors, {
      ...baseConfig,
      provider: 'openrouter',
      apiKeyEnv: 'JEV_TEST_KEY',
    })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://openrouter.ai/api/alpha/decisions')
    expect(result.suggestWebSearch).toBe(true)
    // Choice-only answers carry no noul, so no probability is recorded for them.
    expect(result.rawAnswers).toEqual({ domain: 'general' })
    expect(result.model).toBeUndefined()
    delete process.env.JEV_TEST_KEY
  })

  it('rejects malformed answers and non-success responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    await expect(classifyWithJev('x', undefined, advisors, { ...baseConfig, apiKey: 'secret' })).rejects.toThrow('缺少 answers')
    vi.restoreAllMocks()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 429 }))
    await expect(classifyWithJev('x', undefined, advisors, { ...baseConfig, apiKey: 'secret' })).rejects.toThrow('HTTP 429')
  })

  it('throws instead of silently rejecting when escalate-driving answers are unusable', async () => {
    const run = (answers: unknown) => {
      vi.restoreAllMocks()
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ answers }), { status: 200 }))
      return classifyWithJev('x', undefined, advisors, { ...baseConfig, apiKey: 'secret' })
    }
    // `answers` present but empty — the pre-fix path returned "no advisor needed".
    await expect(run({})).rejects.toThrow('needs_advisor')
    // high_risk missing entirely: must not default to "not high risk".
    await expect(run({ needs_advisor: { noul: 0.1 } })).rejects.toThrow('high_risk')
    // Present but unusable value (string noul) — same treatment as missing.
    await expect(run({ needs_advisor: { noul: 'high' }, high_risk: { noul: 0.2 } })).rejects.toThrow('needs_advisor')
    // An unusable web_search stays tolerated: it only suppresses a hint.
    const ok = await run({ needs_advisor: { noul: 0.1 }, high_risk: { noul: 0.2 }, web_search: { noul: 'x' } })
    expect(ok.shouldEscalate).toBe(false)
    expect(ok.suggestWebSearch).toBe(false)
  })

  it('aborts a request at the configured timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal
      signal?.addEventListener('abort', () =>
        reject(signal?.reason ?? new DOMException('aborted', 'AbortError')))
    }))
    await expect(classifyWithJev('x', undefined, advisors, { ...baseConfig, apiKey: 'secret', timeoutMs: 1 }))
      .rejects.toThrow('Jev 超时（1ms）')
  })

  it('asks single-judgment Noul questions with true/false criteria', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      answers: { needs_advisor: { noul: 0.1 }, high_risk: { noul: 0.1 }, web_search: { noul: 0.1 }, domain: { choice: 'general' } },
    }), { status: 200 }))
    await classifyWithJev('x', 'ctx', advisors, { ...baseConfig, apiKey: 'secret' })
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      questions: Record<string, { type: string, instructions: string, criteria?: { true?: { what?: unknown, examples?: unknown }, false?: { what?: unknown, examples?: unknown } } }>
    }
    for (const id of ['needs_advisor', 'web_search', 'high_risk']) {
      const question = body.questions[id]
      expect(question.type).toBe('noul')
      expect(question.criteria?.true?.what).toBeTypeOf('string')
      expect(question.criteria?.false?.what).toBeTypeOf('string')
      expect(Array.isArray(question.criteria?.true?.examples)).toBe(true)
      expect(Array.isArray(question.criteria?.false?.examples)).toBe(true)
    }
    // Overlap removed: high-risk belongs to the high_risk question alone…
    expect(body.questions.needs_advisor?.instructions.toLowerCase()).not.toContain('high-risk')
    // …and "uncertain" no longer reads as the asker's own confidence.
    expect(body.questions.needs_advisor?.instructions.toLowerCase()).not.toContain('uncertain')
    // high_risk keeps its own domain enumeration.
    expect(body.questions.high_risk?.instructions.toLowerCase()).toContain('medical')
  })

  it('uses the English gist as Jev state only when the toggle is on', async () => {
    // Fresh Response per call: a single mocked body can only be read once.
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      answers: { needs_advisor: { noul: 0.1 }, high_risk: { noul: 0.1 }, web_search: { noul: 0.1 }, domain: { choice: 'general' } },
    }), { status: 200 }))
    const lastState = () => {
      const body = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body)) as { state?: string }
      return body.state
    }

    // Toggle on + gist supplied → the English gist becomes the Jev state (trimmed).
    await classifyWithJev('合同风险', '背景', advisors, { ...baseConfig, apiKey: 'secret', useEnglishState: true }, undefined, '  Contract-risk summary  ')
    expect(lastState()).toBe('Contract-risk summary')

    // Toggle off → the gist is ignored, the Chinese original is used.
    await classifyWithJev('合同风险', '背景', advisors, { ...baseConfig, apiKey: 'secret' }, undefined, 'Contract-risk summary')
    expect(lastState()).toBe('合同风险\n\n背景：背景')

    // Toggle on but no gist → graceful fallback to the Chinese original.
    await classifyWithJev('合同风险', undefined, advisors, { ...baseConfig, apiKey: 'secret', useEnglishState: true })
    expect(lastState()).toBe('合同风险\n\n背景：无')
  })

  it('lets high_risk use its own threshold when configured', async () => {
    const run = (config: JevConfig) => {
      vi.restoreAllMocks()
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
        answers: { needs_advisor: { noul: 0.55 }, high_risk: { noul: 0.55 }, web_search: { noul: 0.1 }, domain: { choice: 'general' } },
      }), { status: 200 }))
      return classifyWithJev('x', undefined, advisors, { ...config, apiKey: 'secret' })
    }
    // Shared threshold (the default): 0.55 stays under 0.6 → no escalation.
    const shared = await run(baseConfig)
    expect(shared.shouldEscalate).toBe(false)
    expect(shared.reason).toBe('Jev 判断该问题不需要启动顾问群。')
    // A lower separate threshold lets the high-risk line fire on its own.
    const split = await run({ ...baseConfig, highRiskThreshold: 0.5 })
    expect(split.shouldEscalate).toBe(true)
    expect(split.reason).toContain('高风险')
  })
})
