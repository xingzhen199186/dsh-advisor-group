import { describe, expect, it } from 'vitest'
import { PROVIDER_PRESETS } from '../src/providers/presets'

/**
 * The OpenCode Go presets come from the local knowledge base
 * (`01-AI大模型供应/opencode/05-Console/05-Go.md`, captured 2026-10-06): the Go
 * gateway serves a **different API family per model**, so the provider is split
 * exactly the way DeepSeek / Moonshot / OpenRouter already are.
 */
describe('OpenCode Go presets', () => {
  const openai = PROVIDER_PRESETS['opencode-go']
  const anthropic = PROVIDER_PRESETS['opencode-go-anthropic']

  it('registers both API families against the Go gateway', () => {
    expect(openai?.protocol).toBe('openai')
    expect(openai?.baseURL).toBe('https://opencode.ai/zen/go/v1')
    expect(openai?.apiKeyEnv).toBe('OPENCODE_GO_API_KEY')
    expect(anthropic?.protocol).toBe('anthropic')
    expect(anthropic?.baseURL).toBe('https://opencode.ai/zen/go/v1')
    expect(anthropic?.apiKeyEnv).toBe('OPENCODE_GO_API_KEY')
  })

  it('carries the session header the gateway asks every client for', () => {
    expect(openai?.headers?.['x-opencode-session']).toBeTypeOf('string')
    expect(openai?.headers?.['x-opencode-session']).not.toBe('')
    // One stable routing key across both families of the same subscription.
    expect(anthropic?.headers?.['x-opencode-session']).toBe(openai?.headers?.['x-opencode-session'])
  })

  it('lists the chat-completions models it can drive, and not the responses ones', () => {
    const models = openai?.defaultModels ?? []
    expect(models).toContain('deepseek-v4-pro')
    expect(models).toContain('glm-5.3')
    expect(models).toContain('kimi-k3')
    expect(models).toContain('mimo-v2.6-pro')
    expect(models).toHaveLength(19)
    // `/v1/responses` models cannot go through the direct-HTTP path at all.
    expect(models).not.toContain('grok-4.7')
    expect(models).not.toContain('gpt-5.6-luna')
  })

  it('lists the anthropic-family models separately', () => {
    expect(anthropic?.defaultModels).toEqual([
      'minimax-m3',
      'minimax-m2.7',
      'qwen3.8-max',
      'qwen3.8-flash',
      'qwen3.7-plus',
    ])
  })

  it('documents the subscription, the key source and the responses exclusion', () => {
    expect(openai?.notes).toContain('opencode.ai/console')
    expect(openai?.notes).toContain('x-opencode-session')
    expect(openai?.notes).toContain('/v1/responses')
  })
})
