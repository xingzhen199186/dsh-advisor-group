import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_ADVISOR_PROMPT } from '../src/defaults'
import {
  guardAdvisorPrompts,
  healAdvisorSystemPrompt,
  reportPromptGuardFindings,
} from '../src/prompt-guard'
import type { Config as ConfigShape } from '../src/config'

const TEMPLATE = DEFAULT_ADVISOR_PROMPT
const FFFD = '\uFFFD'

/**
 * Deterministically overwrite every Nth non-newline character with a
 * replacement char — the byte-loss corruption signature seen live on
 * 2026-09-26 (24 U+FFFD standing in for lost Chinese characters).
 */
function injectReplacements(text: string, everyNthChar = 10): string {
  const chars = [...text]
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '\n') continue
    if (i % everyNthChar === 0) chars[i] = FFFD
  }
  return chars.join('')
}

function sampleConfig(prompts: string[]): ConfigShape {
  return {
    enabled: true,
    discussion: { maxRounds: 2, maxAdvisorsPerCall: 3, parallel: true, autoDeepen: true, stopOnConsensus: false },
    trigger: { requireClassifier: true, allowWebFallback: true, confidenceThreshold: 0.6 },
    ui: { theme: 'retro-green', showTimestamps: true, autoExpand: true },
    quota: { enabled: true, maxPerDay: 50 },
    advisors: prompts.map((systemPrompt, index) => ({
      id: `advisor-${index}`,
      name: `顾问${index}`,
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      systemPrompt,
    })),
  }
}

describe('prompt guard: healAdvisorSystemPrompt', () => {
  it('passes a clean template through untouched', () => {
    const result = healAdvisorSystemPrompt(TEMPLATE)
    expect(result.action).toBe('ok')
    expect(result.value).toBe(TEMPLATE)
  })

  it('leaves a clean customized prompt alone (custom prompts are legitimate)', () => {
    const custom = '这是用户自己改写的提示词，不含任何损坏字符。'
    const result = healAdvisorSystemPrompt(custom)
    expect(result.action).toBe('ok')
    expect(result.value).toBe(custom)
  })

  it('strips a leading BOM and reports it as stripped (not as a template refill)', () => {
    const result = healAdvisorSystemPrompt('\uFEFF' + TEMPLATE)
    expect(result.action).toBe('stripped')
    expect(result.value).toBe(TEMPLATE)
  })

  it('heals injected replacement chars back to the template byte-for-byte', () => {
    const corrupted = injectReplacements(TEMPLATE)
    expect(corrupted).toContain(FFFD)
    const result = healAdvisorSystemPrompt(corrupted)
    expect(result.action).toBe('healed')
    expect(result.value).toBe(TEMPLATE)
  })

  it('refuses to heal when a customized line coexists with replacement chars', () => {
    const lines = TEMPLATE.split('\n')
    lines[1] = '用户改过的行' + FFFD
    const corrupted = lines.join('\n')
    const result = healAdvisorSystemPrompt(corrupted)
    expect(result.action).toBe('needs-manual')
    expect(result.value).toBe(corrupted)
  })

  it('refuses to heal when the line count no longer matches the template', () => {
    const corrupted = TEMPLATE.split('\n').slice(0, -1).join('\n') + FFFD
    const result = healAdvisorSystemPrompt(corrupted)
    expect(result.action).toBe('needs-manual')
    expect(result.value).toBe(corrupted)
  })
})

describe('prompt guard: guardAdvisorPrompts', () => {
  it('heals corrupted advisors into a new config, keeping healthy advisors identical', () => {
    const config = sampleConfig([injectReplacements(TEMPLATE), '干净的自定义提示词'])
    const { config: result, findings } = guardAdvisorPrompts(config)
    expect(result).not.toBe(config)
    expect(result.advisors[0].systemPrompt).toBe(TEMPLATE)
    expect(result.advisors[1]).toBe(config.advisors[1])
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ advisorId: 'advisor-0', action: 'healed' })
  })

  it('returns the exact same config object when everything is clean', () => {
    const config = sampleConfig([TEMPLATE, '自定义提示词'])
    const { config: result, findings } = guardAdvisorPrompts(config)
    expect(result).toBe(config)
    expect(findings).toHaveLength(0)
  })

  it('applies BOM stripping as a config change (stripped counts as a modification)', () => {
    const config = sampleConfig(['\uFEFF' + TEMPLATE])
    const { config: result, findings } = guardAdvisorPrompts(config)
    expect(result).not.toBe(config)
    expect(result.advisors[0].systemPrompt).toBe(TEMPLATE)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ advisorId: 'advisor-0', action: 'stripped' })
  })

  it('keeps the config object untouched on needs-manual, but still records the finding', () => {
    const lines = TEMPLATE.split('\n')
    lines[1] = '用户改过的行' + FFFD
    const config = sampleConfig([lines.join('\n')])
    const { config: result, findings } = guardAdvisorPrompts(config)
    expect(result).toBe(config)
    expect(findings).toHaveLength(1)
    expect(findings[0].action).toBe('needs-manual')
  })
})

describe('prompt guard: reportPromptGuardFindings', () => {
  it('logs one timestamped warning per finding, stating the action actually taken', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      reportPromptGuardFindings([
        { advisorId: 'advisor-a', action: 'healed', reason: '已回填' },
        { advisorId: 'advisor-b', action: 'needs-manual', reason: '需人工' },
        { advisorId: 'advisor-c', action: 'stripped', reason: '开头含 BOM，已剥除' },
      ])
      expect(warn).toHaveBeenCalledTimes(3)
      expect(String(warn.mock.calls[0]?.[0])).toContain('advisor-a')
      expect(String(warn.mock.calls[0]?.[0])).toContain('回填')
      expect(String(warn.mock.calls[1]?.[0])).toContain('advisor-b')
      expect(String(warn.mock.calls[1]?.[0])).toContain('需人工处理')
      expect(String(warn.mock.calls[2]?.[0])).toContain('advisor-c')
      expect(String(warn.mock.calls[2]?.[0])).toContain('BOM')
      expect(String(warn.mock.calls[2]?.[0])).not.toContain('按内置模板回填')
      for (const call of warn.mock.calls) {
        expect(String(call[0])).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[dsh-advisor-group\]/)
      }
    } finally {
      warn.mockRestore()
    }
  })
})
