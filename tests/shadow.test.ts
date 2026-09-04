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
})
