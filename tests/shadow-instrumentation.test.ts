import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

/**
 * 测量口径（2026-09-29 顾问群评审裁定）：影子日志是「该不该上自动哨兵」的唯一证据来源，
 * 所以要记全三件事——谁判的（Jev / 本地回退 / 跳过闸门）、为什么（含 Jev 失败原因），
 * 以及这一轮到底有没有真的启动。`launched` 过去只是把 `shouldEscalate` 抄了一遍，
 * 无法区分「判定放行」与「真的开跑」；本文件锁这三件事在工具层的实际写入。
 */

// See tools-schema.test.ts: the real @deepseek-ai/dsh-tools pulls a host peer
// that is not installed in this repo; pass defineTool options through.
vi.mock('@deepseek-ai/dsh-tools', () => ({
  defineTool: (options: unknown) => options,
}))

const mocks = vi.hoisted(() => ({
  appendShadowSample: vi.fn(),
  classifyWithJev: vi.fn(),
}))

vi.mock('../src/shadow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/shadow')>()
  return { ...actual, appendShadowSample: mocks.appendShadowSample }
})

vi.mock('../src/providers/jev', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/jev')>()
  return { ...actual, classifyWithJev: mocks.classifyWithJev }
})

import { registerAdvisorTools } from '../src/tools'
import { AdvisorGroupService } from '../src/service'
import type { AdvisorConfig, Config, JevConfig } from '../src/config'
import type { JevClassificationResult } from '../src/providers/jev'

const ADVISOR: AdvisorConfig = {
  id: 'a1',
  name: '顾问A',
  provider: 'fake-provider',
  model: 'fake-model',
  systemPrompt: '你是专家。',
}

const JEV: JevConfig = {
  enabled: true,
  provider: 'typesafe',
  model: 'jev-latest',
  timeoutMs: 1000,
  confidenceThreshold: 0.6,
  useEnglishState: false,
}

function config(overrides: Partial<Config['trigger']> = {}): Config {
  return {
    enabled: true,
    discussion: {
      maxRounds: 1,
      maxAdvisorsPerCall: 3,
      parallel: true,
      autoDeepen: true,
      stopOnConsensus: false,
      advisorTimeoutMs: 500,
    },
    trigger: {
      requireClassifier: true,
      allowWebFallback: false,
      confidenceThreshold: 0.6,
      jev: JEV,
      ...overrides,
    },
    ui: {
      theme: 'retro-green',
      showTimestamps: true,
      autoExpand: true,
    },
    quota: {
      enabled: false,
      maxPerDay: 50,
    },
    advisors: [ADVISOR],
  }
}

/** Fake host whose advisor stream answers immediately, so a launched run settles fast. */
function makeService(overrides: Partial<Config['trigger']> = {}): AdvisorGroupService {
  const fakeCtx = {
    on: () => {},
    emit: () => {},
    llm: {
      listProviders: () => [{ id: 'fake-provider' }],
      async *stream() {
        yield { type: 'reasoning-delta', text: '思考中' } as never
        yield { type: 'text-delta', text: '顾问意见。' } as never
      },
    },
  } as unknown as Context
  return new AdvisorGroupService(fakeCtx, config(overrides))
}

function askTool(service: AdvisorGroupService) {
  const ask = registerAdvisorTools(service).find((tool) => tool.name === 'ask_advisors')
  expect(ask).toBeDefined()
  return ask!
}

const exec = { agent: undefined, signal: new AbortController().signal } as never

function lastSample(): Record<string, unknown> {
  expect(mocks.appendShadowSample).toHaveBeenCalled()
  const calls = mocks.appendShadowSample.mock.calls
  return calls[calls.length - 1][0] as Record<string, unknown>
}

function jevVerdict(overrides: Partial<JevClassificationResult> = {}): JevClassificationResult {
  return {
    shouldEscalate: true,
    reason: 'Jev 判断该问题需要顾问群（置信度 0.9）。',
    suggestWebSearch: false,
    suggestedAdvisors: [],
    provider: 'typesafe',
    confidence: 0.9,
    rawAnswers: { needsAdvisor: 0.9, highRisk: 0.1, webSearch: 0.2, domain: 'general' },
    model: 'openrouter/jev-1.13.0',
    ...overrides,
  }
}

beforeEach(() => {
  mocks.appendShadowSample.mockClear()
  mocks.classifyWithJev.mockReset()
})

describe('shadow instrumentation (advisor-review ruling)', () => {
  it('records a Jev verdict together with the real launch outcome', async () => {
    mocks.classifyWithJev.mockResolvedValue(jevVerdict())
    const result = (await askTool(makeService()).execute(
      { question: '这个方案要不要专家判断？' },
      exec,
    )) as { skipped: boolean }

    expect(result.skipped).toBe(false)
    const sample = lastSample()
    expect(sample.provider).toBe('jev')
    expect(sample.launched).toBe(true)
    expect(sample.shouldEscalate).toBe(true)
    expect(sample.scores).toEqual({ needsAdvisor: 0.9, highRisk: 0.1, webSearch: 0.2, domain: 'general' })
    expect(sample.model).toBe('openrouter/jev-1.13.0')
    expect(typeof sample.jevLatencyMs).toBe('number')
    expect('jevError' in sample).toBe(false)
  })

  it('records a rejected verdict as not launched', async () => {
    mocks.classifyWithJev.mockResolvedValue(jevVerdict({
      shouldEscalate: false,
      reason: 'Jev 判断该问题不需要启动顾问群。',
    }))
    const result = (await askTool(makeService()).execute(
      { question: '把这句话改简洁一点' },
      exec,
    )) as { skipped: boolean; reason?: string }

    expect(result.skipped).toBe(true)
    expect(result.reason).toBe('classifier-rejected')
    const sample = lastSample()
    expect(sample.launched).toBe(false)
    expect(sample.provider).toBe('jev')
  })

  it('keeps the Jev failure reason and falls back to the local classifier', async () => {
    mocks.classifyWithJev.mockRejectedValue(new Error('Jev 超时（1000ms）'))
    const result = (await askTool(makeService()).execute(
      { question: '这个手术方案的风险怎么评估？' },
      exec,
    )) as { skipped: boolean }

    expect(result.skipped).toBe(false)
    const sample = lastSample()
    expect(sample.provider).toBe('local')
    expect(sample.jevError).toBe('Jev 超时（1000ms）')
    expect(sample.launched).toBe(true)
    expect(String(sample.reason)).toContain('高风险关键词')
  })

  it('records @顾问群 as a bypass sample without asking Jev', async () => {
    const result = (await askTool(makeService()).execute(
      { question: '@顾问群 这个要不要会诊？' },
      exec,
    )) as { skipped: boolean }

    expect(result.skipped).toBe(false)
    expect(mocks.classifyWithJev).not.toHaveBeenCalled()
    const sample = lastSample()
    expect(sample.bypass).toBe('mention')
    expect(sample.provider).toBe('bypass')
    expect(sample.launched).toBe(true)
  })

  it('records nothing when the classifier gate is switched off', async () => {
    const result = (await askTool(makeService({ requireClassifier: false })).execute(
      { question: '随便问一句' },
      exec,
    )) as { skipped: boolean }

    expect(result.skipped).toBe(false)
    expect(mocks.appendShadowSample).not.toHaveBeenCalled()
  })

  it('records the web-search recommendation as not launched', async () => {
    mocks.classifyWithJev.mockResolvedValue(jevVerdict({
      shouldEscalate: false,
      suggestWebSearch: true,
      reason: 'Jev 判断该问题更适合联网搜索。',
    }))
    const result = (await askTool(makeService({ allowWebFallback: true })).execute(
      { question: '今天几点日落？' },
      exec,
    )) as { reason?: string }

    expect(result.reason).toBe('web-search-recommended')
    expect(lastSample().launched).toBe(false)
  })
})
