import { describe, expect, it } from 'vitest'
import {
  assertSafeDiagnosticBase,
  maskApiKey,
  reconcileApiKeys,
  resolveDiagnosticApiKey,
} from '../src/settings-api'
import type { Config, AdvisorConfig } from '../src/config'
import type { AdvisorGroupService } from '../src/service'

/** Minimal service stub exposing only getConfig for the diagnostic resolver. */
function serviceWithConfig(config: Config): Pick<AdvisorGroupService, 'getConfig'> {
  return { getConfig: () => config } as Pick<AdvisorGroupService, 'getConfig'>
}

function advisor(overrides: Partial<AdvisorConfig>): AdvisorConfig {
  return {
    id: 'advisor-a',
    name: '顾问A',
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    systemPrompt: '你是资深专家。',
    ...overrides,
  }
}

function config(advisors: AdvisorConfig[]): Config {
  return {
    enabled: true,
    discussion: { maxRounds: 2, maxAdvisorsPerCall: 3, parallel: true, autoDeepen: true, stopOnConsensus: false },
    trigger: { requireClassifier: true, allowWebFallback: true, confidenceThreshold: 0.6 },
    ui: { theme: 'retro-green', showTimestamps: true, autoExpand: true },
    advisors,
  }
}

describe('settings api key reconcile', () => {
  it('masks with the same length as the original key', () => {
    const original = 'sk-deepseek-1234'
    const masked = maskApiKey(original)
    expect(masked).toBe(`${'*'.repeat(original.length - 4)}${original.slice(-4)}`)
    expect(masked?.length).toBe(original.length)
  })

  it('preserves the existing key when the client echoes the exact mask on the same provider', () => {
    const previous = config([advisor({ provider: 'deepseek', apiKey: 'sk-deepseek-1234' })])
    const incoming = config([
      advisor({ provider: 'deepseek', apiKey: maskApiKey('sk-deepseek-1234') }),
    ])

    const result = reconcileApiKeys(incoming, previous)
    expect(result.advisors[0]?.apiKey).toBe('sk-deepseek-1234')
  })

  it('accepts the legacy 4-asterisk mask to preserve the existing key', () => {
    const previous = config([advisor({ provider: 'deepseek', apiKey: 'sk-deepseek-1234' })])
    const incoming = config([
      advisor({ provider: 'deepseek', apiKey: '****1234' }),
    ])

    const result = reconcileApiKeys(incoming, previous)
    expect(result.advisors[0]?.apiKey).toBe('sk-deepseek-1234')
  })

  it('clears the old key when the provider changed and the client echoed the old mask', () => {
    const previous = config([advisor({ provider: 'deepseek', apiKey: 'sk-deepseek-1234' })])
    const incoming = config([
      advisor({
        provider: 'zhipu',
        baseURL: 'https://open.bigmodel.cn/api/paas/v4',
        apiKeyEnv: 'ZHIPU_API_KEY',
        protocol: 'openai',
        apiKey: maskApiKey('sk-deepseek-1234'),
      }),
    ])

    const result = reconcileApiKeys(incoming, previous)
    expect(result.advisors[0]?.apiKey).toBeUndefined()
  })

  it('accepts a new plaintext key when switching providers', () => {
    const previous = config([advisor({ provider: 'deepseek', apiKey: 'sk-deepseek-1234' })])
    const incoming = config([
      advisor({
        provider: 'zhipu',
        baseURL: 'https://open.bigmodel.cn/api/paas/v4',
        apiKeyEnv: 'ZHIPU_API_KEY',
        protocol: 'openai',
        apiKey: 'sk-zhipu-newkey',
      }),
    ])

    const result = reconcileApiKeys(incoming, previous)
    expect(result.advisors[0]?.apiKey).toBe('sk-zhipu-newkey')
  })

  it('keeps the stored direct key when the client sends an empty key on the same provider (SecretField semantics)', () => {
    const previous = config([advisor({ provider: 'zhipu', apiKeyEnv: 'ZHIPU_API_KEY', apiKey: 'sk-old-direct' })])
    const incoming = config([advisor({ provider: 'zhipu', apiKeyEnv: 'ZHIPU_API_KEY', apiKey: '' })])
    const omitted = config([advisor({ provider: 'zhipu', apiKeyEnv: 'ZHIPU_API_KEY' })])

    const result = reconcileApiKeys(incoming, previous)
    const resultOmitted = reconcileApiKeys(omitted, previous)
    expect(result.advisors[0]?.apiKey).toBe('sk-old-direct')
    expect(resultOmitted.advisors[0]?.apiKey).toBe('sk-old-direct')
  })

  it('clears the direct key AND its archived copy when the client sends clearApiKey', () => {
    const previous = config([
      advisor({
        provider: 'zhipu',
        apiKeyEnv: 'ZHIPU_API_KEY',
        apiKey: 'sk-old-direct',
        apiKeysByProvider: { zhipu: 'sk-old-direct', deepseek: 'sk-archived' },
      }),
    ])
    const incoming = config([
      advisor({ provider: 'zhipu', apiKeyEnv: 'ZHIPU_API_KEY', apiKey: '', clearApiKey: true }),
    ])

    const result = reconcileApiKeys(incoming, previous)
    expect(result.advisors[0]?.apiKey).toBeUndefined()
    expect(result.advisors[0]?.apiKeysByProvider?.zhipu).toBeUndefined()
    // Unrelated provider history survives the clear.
    expect(result.advisors[0]?.apiKeysByProvider?.deepseek).toBe('sk-archived')
    // The transient flag never persists.
    expect(result.advisors[0]?.clearApiKey).toBeUndefined()
  })

  it('accepts a new plaintext key for the same provider', () => {
    const previous = config([advisor({ provider: 'deepseek', apiKey: 'sk-old-key' })])
    const incoming = config([advisor({ provider: 'deepseek', apiKey: 'sk-new-key' })])

    const result = reconcileApiKeys(incoming, previous)
    expect(result.advisors[0]?.apiKey).toBe('sk-new-key')
  })

  it('remembers the old provider key when switching away', () => {
    const previous = config([advisor({ provider: 'deepseek', apiKey: 'sk-deepseek-1234' })])
    const incoming = config([advisor({ provider: 'kimi', apiKey: undefined })])

    const result = reconcileApiKeys(incoming, previous)
    expect(result.advisors[0]?.apiKey).toBeUndefined()
    expect(result.advisors[0]?.apiKeysByProvider?.deepseek).toBe('sk-deepseek-1234')
  })

  it('restores a provider key from history when switching back', () => {
    const previous = config([
      advisor({
        provider: 'kimi',
        apiKey: undefined,
        apiKeysByProvider: { deepseek: 'sk-deepseek-1234' },
      }),
    ])
    const incoming = config([advisor({ provider: 'deepseek', apiKey: undefined })])

    const result = reconcileApiKeys(incoming, previous)
    expect(result.advisors[0]?.apiKey).toBe('sk-deepseek-1234')
    expect(result.advisors[0]?.apiKeysByProvider?.deepseek).toBe('sk-deepseek-1234')
  })

  describe('resolveDiagnosticApiKey (models list / connection test)', () => {
    const key = 'sk-deepseek-1234567890'

    function stored(overrides: Partial<AdvisorConfig> = {}): Pick<AdvisorGroupService, 'getConfig'> {
      return serviceWithConfig(
        config([
          advisor({
            provider: 'deepseek',
            apiKey: key,
            ...overrides,
          }),
        ]),
      )
    }

    it('substitutes the stored real key when the form echoes its mask', () => {
      const resolved = resolveDiagnosticApiKey(
        stored(),
        'advisor-a',
        'deepseek',
        '',
        '',
        'openai',
        maskApiKey(key) ?? '',
      )
      expect(resolved).toBe(key)
    })

    it('substitutes the stored real key when the field is empty (same scope)', () => {
      const resolved = resolveDiagnosticApiKey(
        stored(),
        'advisor-a',
        'deepseek',
        '',
        '',
        'openai',
        '',
      )
      expect(resolved).toBe(key)
    })

    it('a freshly typed plaintext key always wins over the stored one', () => {
      const resolved = resolveDiagnosticApiKey(
        stored(),
        'advisor-a',
        'deepseek',
        '',
        '',
        'openai',
        'sk-fresh-typed',
      )
      expect(resolved).toBe('sk-fresh-typed')
    })

    it('falls back to the archived key for a previously used provider', () => {
      const service = stored({ provider: 'kimi', apiKey: undefined, apiKeysByProvider: { deepseek: key } })
      const resolved = resolveDiagnosticApiKey(
        service,
        'advisor-a',
        'deepseek',
        '',
        '',
        'openai',
        '',
      )
      expect(resolved).toBe(key)
    })

    it('keeps the inbound value for an unknown advisor id', () => {
      const resolved = resolveDiagnosticApiKey(
        stored(),
        'advisor-unknown',
        'deepseek',
        '',
        '',
        'openai',
        maskApiKey(key) ?? '',
      )
      expect(resolved).toBe(maskApiKey(key))
    })
  })

  describe('assertSafeDiagnosticBase (SSRF guard)', () => {
    it('accepts https domain bases', () => {
      expect(assertSafeDiagnosticBase('https://api.example.com/v1')).toBeNull()
      expect(assertSafeDiagnosticBase('https://open.bigmodel.cn/api/paas/v4')).toBeNull()
    })

    it('accepts loopback http bases for local providers', () => {
      expect(assertSafeDiagnosticBase('http://127.0.0.1:8000/v1')).toBeNull()
      expect(assertSafeDiagnosticBase('http://localhost:11434/v1')).toBeNull()
    })

    it('rejects http bases that are not loopback', () => {
      expect(assertSafeDiagnosticBase('http://192.168.1.10:8080/v1')).not.toBeNull()
      expect(assertSafeDiagnosticBase('http://example.com/v1')).not.toBeNull()
    })

    it('rejects IP literals under https', () => {
      expect(assertSafeDiagnosticBase('https://10.0.0.1/v1')).not.toBeNull()
      expect(assertSafeDiagnosticBase('https://172.16.0.1/v1')).not.toBeNull()
      expect(assertSafeDiagnosticBase('https://192.168.0.1/v1')).not.toBeNull()
      expect(assertSafeDiagnosticBase('https://169.254.169.254/v1')).not.toBeNull()
      expect(assertSafeDiagnosticBase('https://[::1]/v1')).not.toBeNull()
    })

    it('rejects cloud metadata hostnames', () => {
      expect(assertSafeDiagnosticBase('https://metadata.google.internal/v1')).not.toBeNull()
      expect(assertSafeDiagnosticBase('https://metadata.azure.com/v1')).not.toBeNull()
    })

    it('rejects malformed or empty input', () => {
      expect(assertSafeDiagnosticBase('')).not.toBeNull()
      expect(assertSafeDiagnosticBase('not a url')).not.toBeNull()
      expect(assertSafeDiagnosticBase('ftp://example.com/v1')).not.toBeNull()
    })
  })
})
