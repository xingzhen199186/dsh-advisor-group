import { describe, expect, it } from 'vitest'
import { advisorsMissingModel } from '../src/model-validation'

const baseAdvisor = {
  id: 'a',
  name: '顾问A',
  provider: 'deepseek',
  model: 'deepseek-v4-pro',
  systemPrompt: '你是专家。',
}

describe('advisor model validation', () => {
  it('returns empty when every advisor has a model', () => {
    expect(advisorsMissingModel([{ ...baseAdvisor }])).toHaveLength(0)
  })

  it('flags advisors with an empty or whitespace-only model', () => {
    const missing = advisorsMissingModel([
      { ...baseAdvisor },
      { ...baseAdvisor, id: 'b', name: '顾问B', model: '' },
      { ...baseAdvisor, id: 'c', name: '顾问C', model: '   ' },
    ])
    expect(missing.map((a) => a.id).sort()).toEqual(['b', 'c'])
  })
})
