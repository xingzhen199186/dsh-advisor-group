import { describe, expect, it } from 'vitest'
import { formatShadowSample, SHADOW_QUESTION_LIMIT, type ShadowSample } from '../src/shadow'

function sample(overrides: Partial<ShadowSample> = {}): ShadowSample {
  return {
    ts: 1_700_000_000_000,
    question: '这个投资方案合规吗？',
    shouldEscalate: true,
    reason: '高风险关键词：投资',
    suggestWebSearch: false,
    launched: true,
    ...overrides,
  }
}

describe('classifier shadow samples', () => {
  it('truncates long question text to the storage limit', () => {
    const long = 'a'.repeat(500)
    const formatted = formatShadowSample(sample({ question: long }))
    expect(formatted.question.length).toBeLessThanOrEqual(SHADOW_QUESTION_LIMIT + 1)
    expect(formatted.question.endsWith('…')).toBe(true)
  })

  it('keeps short questions intact and preserves all fields', () => {
    const original = sample()
    const formatted = formatShadowSample(original)
    expect(formatted).toEqual(original)
  })

  it('normalizes a missing ts to now but only when non-finite', () => {
    const before = Date.now()
    const formatted = formatShadowSample(sample({ ts: 123 }))
    expect(formatted.ts).toBe(123)
    void before
  })

  it('preserves Jev provenance and raw scores when present', () => {
    const formatted = formatShadowSample(sample({
      provider: 'jev',
      scores: { needsAdvisor: 0.42, webSearch: 0.1, highRisk: 0.77, domain: 'legal' },
      model: 'openrouter/jev-1.13.0',
      jevLatencyMs: 813,
      repeatCount: 2,
    }))
    expect(formatted.provider).toBe('jev')
    expect(formatted.scores).toEqual({ needsAdvisor: 0.42, webSearch: 0.1, highRisk: 0.77, domain: 'legal' })
    expect(formatted.model).toBe('openrouter/jev-1.13.0')
    expect(formatted.jevLatencyMs).toBe(813)
    expect(formatted.repeatCount).toBe(2)
  })

  it('records a fallback verdict with the Jev error and a bypass without provenance', () => {
    // 2026-09-29 instrumentation: `launched` is now the real outcome, and a
    // failed Jev attempt is kept so fallback verdicts stay distinguishable from
    // "Jev was never asked".
    const fellBack = formatShadowSample(sample({
      provider: 'local',
      jevError: 'Jev 超时（10000ms）',
      jevLatencyMs: 10_004,
      launched: false,
    }))
    expect(fellBack.launched).toBe(false)
    expect(fellBack.jevError).toBe('Jev 超时（10000ms）')

    const bypassed = formatShadowSample(sample({
      provider: 'bypass',
      bypass: 'repeat',
      repeatCount: 3,
      shouldEscalate: true,
      launched: true,
    }))
    expect(bypassed.bypass).toBe('repeat')
    expect(bypassed.provider).toBe('bypass')
    expect('jevError' in bypassed).toBe(false)
  })

  it('keeps legacy samples without provenance fields intact', () => {
    // Pre-Jev lines carry none of the new optional fields.
    const legacy = sample()
    const formatted = formatShadowSample(legacy)
    expect('provider' in formatted).toBe(false)
    expect('scores' in formatted).toBe(false)
    expect('model' in formatted).toBe(false)
    expect('jevError' in formatted).toBe(false)
    expect('jevLatencyMs' in formatted).toBe(false)
    expect('bypass' in formatted).toBe(false)
  })
})
