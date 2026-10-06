import { describe, expect, it } from 'vitest'
import { PROVIDER_PRESETS } from '../src/providers/presets'

/**
 * The OpenCode Go presets come from the local knowledge base
 * (`01-AI大模型供应/opencode/05-Console/05-Go.md`, captured 2026-10-06) and were
 * then corrected against the live gateway: both surfaces serve nearly the whole
 * catalogue, the Anthropic one authenticates with `x-api-key` (a Bearer header
 * there is answered with 「Missing API key」), and only `grok-4.6`/`grok-4.7`
 * are `/v1/responses`-only, i.e. unusable through the direct-HTTP path.
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

  it('uses the auth scheme each surface accepts (Bearer vs x-api-key)', () => {
    // Live probe: /chat/completions reads `authorization: Bearer …`, while
    // /v1/messages only reads `x-api-key` — sending Bearer there returns 401
    // 「Missing API key.」, which is exactly how the first release shipped broken.
    expect(openai?.authMode).toBe('bearer')
    expect(anthropic?.authMode).toBe('x-api-key')
  })

  it('carries the session header the gateway asks every client for', () => {
    expect(openai?.headers?.['x-opencode-session']).toBeTypeOf('string')
    expect(openai?.headers?.['x-opencode-session']).not.toBe('')
    // One stable routing key across both families of the same subscription.
    expect(anthropic?.headers?.['x-opencode-session']).toBe(openai?.headers?.['x-opencode-session'])
  })

  it('lists the live catalogue minus the responses-only models', () => {
    const models = openai?.defaultModels ?? []
    expect(models).toContain('deepseek-v4-pro')
    expect(models).toContain('glm-5.3')
    expect(models).toContain('kimi-k3')
    expect(models).toContain('mimo-v2.6-pro')
    expect(models).toHaveLength(41)
    // `grok-4.6/4.7` answer 「not supported for format oa-compat/anthropic」.
    expect(models).not.toContain('grok-4.6')
    expect(models).not.toContain('grok-4.7')
  })

  it('offers the same models through the Anthropic surface', () => {
    expect(anthropic?.defaultModels).toEqual(openai?.defaultModels)
  })

  it('documents the subscription, the key source and the auth trap', () => {
    expect(openai?.notes).toContain('opencode.ai/console')
    expect(openai?.notes).toContain('x-opencode-session')
    expect(openai?.notes).toContain('/v1/responses')
    expect(anthropic?.notes).toContain('x-api-key')
  })
})
