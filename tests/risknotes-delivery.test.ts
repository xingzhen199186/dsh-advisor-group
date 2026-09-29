import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

/**
 * 送达张力决议（2026-09-26 用户裁定「按建议来」）：riskNotes 必须进 ask_advisors
 * 工具返回——风险提示的收信人包含主模型，它要随限定的对话与结论一起送达，而不是
 * 只留在卡片和会话日志里。锁两条组装路径（新会话带综合结论、followUp 追问）与
 * 「空 riskNotes 不出空块」。
 *
 * 2026-09-29 起提示只由事实标志驱动（关键词规则已删，见 src/risk-notes.ts），
 * 所以这里用「顾问流超时截断」造提示，并额外锁住「正文提风险不再产生提示」。
 */

// See tools-schema.test.ts: the real @deepseek-ai/dsh-tools pulls a host
// peer that is not installed in this repo; pass defineTool options through.
vi.mock('@deepseek-ai/dsh-tools', () => ({
  defineTool: (options: unknown) => options,
}))

import { registerAdvisorTools } from '../src/tools'
import { AdvisorGroupService } from '../src/service'
import { TRUNCATION_NOTE } from '../src/risk-notes'
import type { AdvisorConfig, Config } from '../src/config'

const ADVISOR: AdvisorConfig = {
  id: 'a1',
  name: '顾问A',
  provider: 'fake-provider',
  model: 'fake-model',
  systemPrompt: '你是专家。',
}

function config(maxRounds: number): Config {
  return {
    enabled: true,
    discussion: {
      maxRounds,
      maxAdvisorsPerCall: 3,
      parallel: true,
      autoDeepen: true,
      stopOnConsensus: false,
      advisorTimeoutMs: 60,
    },
    // Skip the classifier block entirely: these tests exercise the assembly
    // sites, not escalation policy.
    trigger: {
      requireClassifier: false,
      allowWebFallback: false,
      confidenceThreshold: 0.6,
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

/** 顾问流只吐思考链，然后挂住直到超时把它掐断 → 消息带 truncated(timeout)。 */
function makeTruncatingService(maxRounds: number): AdvisorGroupService {
  const fakeCtx = {
    on: () => {},
    emit: () => {},
    llm: {
      listProviders: () => [{ id: 'fake-provider' }],
      async *stream(options: { signal?: AbortSignal }) {
        yield { type: 'reasoning-delta', text: '长思考链' } as never
        await new Promise<never>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          )
        })
      },
    },
  } as unknown as Context
  return new AdvisorGroupService(fakeCtx, config(maxRounds))
}

/** 顾问正常作答（可塞满风险字眼）。 */
function makeAnsweringService(answer: string): AdvisorGroupService {
  const fakeCtx = {
    on: () => {},
    emit: () => {},
    llm: {
      listProviders: () => [{ id: 'fake-provider' }],
      async *stream() {
        yield { type: 'reasoning-delta', text: '思考中' } as never
        yield { type: 'text-delta', text: answer } as never
      },
    },
  } as unknown as Context
  return new AdvisorGroupService(fakeCtx, config(1))
}

type AskResult = { sessionId: string; advice: string; skipped?: boolean; reason?: string }

function askTool(service: AdvisorGroupService) {
  const ask = registerAdvisorTools(service).find((tool) => tool.name === 'ask_advisors')
  expect(ask).toBeDefined()
  return ask!
}

const exec = { agent: undefined, signal: undefined } as never

describe('riskNotes in the ask_advisors tool result (delivery-tension ruling)', () => {
  it('new consultation: a truncated advisor appends 【风险提示】 after the synthesis', async () => {
    const ask = askTool(makeTruncatingService(1))
    const result = (await ask.execute({ question: '测试问题' }, exec)) as AskResult

    expect(result.skipped).toBe(false)
    expect(result.advice).toContain('【综合结论】')
    expect(result.advice).toContain('【风险提示】')
    expect(result.advice).toContain(TRUNCATION_NOTE)
  })

  it('new consultation: risk words in clean prose no longer produce a block', async () => {
    const ask = askTool(makeAnsweringService('这个方案存在风险，不确定性较高，请谨慎评估。'))
    const result = (await ask.execute({ question: '测试问题' }, exec)) as AskResult

    expect(result.skipped).toBe(false)
    expect(result.advice).not.toContain('【风险提示】')
  })

  it('follow-up round: risk notes reach the main model on the followUp path too', async () => {
    // followUp needs a live session with rounds left: maxRounds 2, one direct
    // round already run, then the follow-up takes round 2 (same pattern as
    // followup-guard.test.ts).
    const service = makeTruncatingService(2)
    const ask = askTool(service)
    const session = service.createSession('测试问题', undefined, [], 'C:\\work')
    await service.runOneRoundAndSummarize(session)

    const result = (await ask.execute(
      { sessionId: session.id, followUp: '再追问一次' },
      exec,
    )) as AskResult

    expect(result.skipped).toBe(false)
    expect(result.advice).toContain('【风险提示】')
    expect(result.advice).toContain(TRUNCATION_NOTE)
  })
})
