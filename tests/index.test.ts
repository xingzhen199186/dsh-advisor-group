import { describe, expect, it } from 'vitest'
import { classifyRequest } from '../src/classifier'
import type { AdvisorConfig } from '../src/config'

const advisors: AdvisorConfig[] = [
  {
    id: 'legal-expert',
    name: '法务专家',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    systemPrompt: '你是资深法律顾问。',
  },
  {
    id: 'code-reviewer',
    name: '架构评审官',
    provider: 'openai',
    model: 'gpt-5',
    systemPrompt: '你是资深软件架构师。',
  },
]

describe('dsh-advisor-group classifier', () => {
  it('escalates high-risk questions', () => {
    const result = classifyRequest('这个合同条款有什么法律风险？', undefined, advisors)
    expect(result.shouldEscalate).toBe(true)
    expect(result.suggestedAdvisors).toContain('legal-expert')
  })

  it('suggests web search for current factual questions', () => {
    const result = classifyRequest('今天天气怎么样？', undefined, advisors)
    expect(result.shouldEscalate).toBe(false)
    expect(result.suggestWebSearch).toBe(true)
  })

  it('escalates world-knowledge questions', () => {
    const result = classifyRequest('如何理解行业里“长期主义”这个概念的演变？', undefined, advisors)
    expect(result.shouldEscalate).toBe(true)
  })

  it('does not escalate simple questions by default', () => {
    const result = classifyRequest('帮我把这句话改得通顺一点。', undefined, advisors)
    expect(result.shouldEscalate).toBe(false)
  })
})
