import { describe, expect, it } from 'vitest'
import { redactSecrets } from '@deepseek-ai/dsh-settings'
import { Config } from '../src/config'
import type { Config as ConfigShape } from '../src/config'

function sample(): ConfigShape {
  return {
    enabled: true,
    discussion: { maxRounds: 2, maxAdvisorsPerCall: 3, parallel: true, autoDeepen: true, stopOnConsensus: false },
    trigger: { requireClassifier: true, allowWebFallback: true, confidenceThreshold: 0.6 },
    ui: { theme: 'retro-green', showTimestamps: true, autoExpand: true },
    advisors: [
      {
        id: 'advisor-a',
        name: '顾问A',
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        systemPrompt: '你是资深专家。',
        apiKey: 'sk-deepseek-1234',
        apiKeysByProvider: { deepseek: 'sk-deepseek-1234', kimi: 'sk-kimi-5678' },
      },
      {
        id: 'advisor-b',
        name: '顾问B',
        provider: 'kimi',
        model: 'kimi-k2',
        systemPrompt: '你是另一名专家。',
      },
    ],
  }
}

/**
 * Locks the official redaction contract for the advisor-group settings section:
 * every key-bearing field (`apiKey` direct key AND the server-side per-provider
 * history) must be marked role('secret'), so Host `describe` / settingsScope /
 * export surfaces can never leak key material.
 */
describe('settings secret redaction (role(secret))', () => {
  const { value, secrets } = redactSecrets(Config as never, sample())

  it('removes the direct apiKey from the redacted value', () => {
    const advisorA = (value as ConfigShape).advisors[0] as unknown as Record<string, unknown>
    expect(advisorA).toBeDefined()
    expect(advisorA.apiKey).toBeUndefined()
  })

  it('removes apiKeysByProvider (per-provider key history) from the redacted value', () => {
    const advisorA = (value as ConfigShape).advisors[0] as unknown as Record<string, unknown>
    expect(advisorA.apiKeysByProvider).toBeUndefined()
  })

  it('enumerates both secret positions with concrete array-index paths', () => {
    const paths = new Set(secrets.map((secret) => secret.path.join('/')))
    expect(paths.has('advisors/0/apiKey')).toBe(true)
    expect(paths.has('advisors/0/apiKeysByProvider')).toBe(true)
    // An unset secret slot is still enumerated so a form knows it exists.
    expect(paths.has('advisors/1/apiKey')).toBe(true)
    expect(paths.has('advisors/1/apiKeysByProvider')).toBe(true)
  })

  it('records set=true only where a value was actually present', () => {
    const byPath = new Map(secrets.map((secret) => [secret.path.join('/'), secret.set]))
    expect(byPath.get('advisors/0/apiKey')).toBe(true)
    expect(byPath.get('advisors/1/apiKey')).toBe(false)
  })

  it('keeps non-secret fields intact in the redacted value', () => {
    const valueAs = value as ConfigShape
    expect(valueAs.enabled).toBe(true)
    expect(valueAs.advisors[0]?.name).toBe('顾问A')
    expect(valueAs.advisors[0]?.provider).toBe('deepseek')
  })
})
