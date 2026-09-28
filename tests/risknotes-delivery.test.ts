import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

/**
 * 送达张力决议（2026-09-26 用户裁定「按建议来」）：riskNotes 必须进 ask_advisors
 * 工具返回——卡片文案「请主模型谨慎采用」的收信人就是主模型，风险提示要随它限定
 * 的对话与结论一起送达，而不是只留在卡片和会话日志里。
 * 锁两条组装路径（新会话带综合结论、followUp 追问）与「空 riskNotes 不出空块」。
 */

// See tools-schema.test.ts: the real @deepseek-ai/dsh-tools pulls a host
// peer that is not installed in this repo; pass defineTool options through.
vi.mock('@deepseek-ai/dsh-tools', () => ({
  defineTool: (options: unknown) => options,
}))

import { registerAdvisorTools } from '../src/tools'
import { AdvisorGroupService } from '../src/service'
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
      advisorTimeoutMs: 10_000,
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

/** Every stream call (driver AND advisor) answers with the same text. */
function makeService(answer: string): AdvisorGroupService {
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
const RISK_NOTE = '部分顾问提到了风险、不确定性或置信度较低，请主模型谨慎采用。'

describe('riskNotes in the ask_advisors tool result (delivery-tension ruling)', () => {
  it('new consultation: risk hit appends 【风险提示】 after the synthesis', async () => {
    const ask = askTool(makeService('这个方案存在风险，需要谨慎评估。'))
    const result = (await ask.execute({ question: '测试问题' }, exec)) as AskResult

    expect(result.skipped).toBe(false)
    expect(result.advice).toContain('【综合结论】')
    expect(result.advice).toContain('【风险提示】')
    expect(result.advice).toContain(RISK_NOTE)
  })

  it('new consultation: no risk hit omits the block entirely (no empty header)', async () => {
    const ask = askTool(makeService('顾问的常规回答。'))
    const result = (await ask.execute({ question: '测试问题' }, exec)) as AskResult

    expect(result.skipped).toBe(false)
    expect(result.advice).not.toContain('【风险提示】')
  })

  it('follow-up round: risk notes reach the main model on the followUp path too', async () => {
    // followUp needs a live session with rounds left: maxRounds 2, one direct
    // round already run, then the follow-up takes round 2 (same pattern as
    // followup-guard.test.ts).
    const service = new AdvisorGroupService(
      {
        on: () => {},
        emit: () => {},
        llm: {
          listProviders: () => [{ id: 'fake-provider' }],
          async *stream() {
            yield { type: 'text-delta', text: '此项存在风险。' } as never
          },
        },
      } as unknown as Context,
      config(2),
    )
    const ask = askTool(service)
    const session = service.createSession('测试问题', undefined, [], 'C:\\work')
    await service.runOneRoundAndSummarize(session)

    const result = (await ask.execute(
      { sessionId: session.id, followUp: '再追问一次' },
      exec,
    )) as AskResult

    expect(result.skipped).toBe(false)
    expect(result.advice).toContain('【风险提示】')
    expect(result.advice).toContain(RISK_NOTE)
  })

  it('real advisor prose (live session bab555f3) still trips the keyword rule', async () => {
    // Contract fixture captured 2026-09-26 from a real consultation whose
    // delivery was verified end-to-end: ordinary multi-clause prose with
    // full-width punctuation and markdown (not just a short synthetic line)
    // must still hit the keyword rule and deliver the same golden note.
    const realProse =
      '（双证校对、门禁两轮全绿、本机冒烟通过），**当前最大的风险不在代码，而在「验证深度不足」与「发布链路状态不一致」**：真实顾问会话未走新代码路径。'
    const ask = askTool(makeService(realProse))
    const result = (await ask.execute({ question: '测试问题' }, exec)) as AskResult

    expect(result.skipped).toBe(false)
    expect(result.advice).toContain('【风险提示】')
    expect(result.advice).toContain(RISK_NOTE)
  })
})
