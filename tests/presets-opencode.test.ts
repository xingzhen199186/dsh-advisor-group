import { describe, expect, it } from 'vitest'
import { PROVIDER_PRESETS } from '../src/providers/presets'

/**
 * The OpenCode Go presets come from the local knowledge base
 * (`01-AI大模型供应/opencode/05-Console/05-Go.md`, captured 2026-10-06) and were
 * then probed against the live gateway. Three findings are pinned here:
 *
 * 1. `/chat/completions` reads `authorization: Bearer`, while `/v1/messages`
 *    reads `x-api-key` — a Bearer header there returns 401 「Missing API key.」.
 * 2. The gateway validates the key **before** the protocol, so a bogus-key probe
 *    can prove an endpoint reachable but never prove a model fits: with a real
 *    key, `glm-5.3` on `/v1/messages` is refused with 400
 *    `ModelProtocolUnsupported`. The knowledge-base model × endpoint table is
 *    therefore the authority on which models each surface serves.
 * 3. Only `grok-4.6`/`grok-4.7` answer 「not supported for format oa-compat」
 *    on the OpenAI surface: they need `/v1/responses`, which the direct-HTTP
 *    path does not speak.
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
    expect(openai?.authMode).toBe('bearer')
    expect(anthropic?.authMode).toBe('x-api-key')
  })

  it('carries the session header the gateway asks every client for', () => {
    expect(openai?.headers?.['x-opencode-session']).toBeTypeOf('string')
    expect(openai?.headers?.['x-opencode-session']).not.toBe('')
    // One stable routing key across both families of the same subscription.
    expect(anthropic?.headers?.['x-opencode-session']).toBe(openai?.headers?.['x-opencode-session'])
  })

  it('lists only the chat-completions models it can actually drive', () => {
    const models = openai?.defaultModels ?? []
    expect(models).toContain('deepseek-v4-pro')
    expect(models).toContain('glm-5.3')
    expect(models).toContain('kimi-k3')
    expect(models).toContain('mimo-v2.6-pro')
    expect(models).toHaveLength(19)
    // `/v1/responses`-only models must not be offered on this surface.
    expect(models).not.toContain('grok-4.6')
    expect(models).not.toContain('grok-4.7')
    expect(models).not.toContain('gpt-5.6-luna')
    expect(models).not.toContain('muse-spark-1.3-contributor')
  })

  it('lists exactly the anthropic-family models on the messages surface', () => {
    // Anything else there is refused with 400 ModelProtocolUnsupported.
    expect(anthropic?.defaultModels).toEqual([
      'minimax-m3',
      'minimax-m2.7',
      'qwen3.8-max',
      'qwen3.8-flash',
      'qwen3.7-plus',
    ])
    expect(anthropic?.defaultModels).not.toContain('glm-5.3')
  })

  it('documents the subscription, the key source and both traps', () => {
    expect(openai?.notes).toContain('opencode.ai/console')
    expect(openai?.notes).toContain('x-opencode-session')
    expect(openai?.notes).toContain('/v1/responses')
    expect(anthropic?.notes).toContain('x-api-key')
  })
})
