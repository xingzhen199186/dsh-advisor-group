import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildRiskNotes, CANCEL_NOTE, TRUNCATION_NOTE } from '../src/risk-notes'
import type { TruncationInfo } from '../src/types'

/**
 * 风险提示只剩两条**事实性**规则：截断 / 取消。
 *
 * 2026-09-29 用户裁定「删」：关键词启发式提示（原 KEYWORD_RISK_NOTE）已移除——它靠
 * 扫描顾问正文里的「风险 / 不确定 / confidence」等字眼去猜顾问有没有表达保留，在冻结
 * 盲测的 10 条未见新写法里误报 4 条（4 条纯否定句全部误报），而 3 条真实截断 + 2 条
 * 真实取消全部判对。与其继续投 v3，不如只留不会因措辞变化误报的两条事实提示。
 * 证据与封存记录见 tasks/todo.md「盲测集 落盘与冻结记录」。
 *
 * 本文件两部分：
 * 1) 真实会话样本（tests/fixtures/risk-notes/real-cases.jsonl，取自宿主会话日志与快照）逐条回归；
 * 2) 「正文不再参与判定」这条决策的回归锁——措辞怎么变都不该再产生或消灭提示。
 */

interface RealCase {
  id: string
  kind: 'truncation' | 'cancel'
  source: 'real'
  origin: string
  messages: { content?: string; truncated?: TruncationInfo }[]
  cancelled: boolean
  labelReason: string
}

const rawText = readFileSync(
  new URL('./fixtures/risk-notes/real-cases.jsonl', import.meta.url),
  'utf8',
)
const realCases: RealCase[] = rawText
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as RealCase)

describe('risk notes: 真实会话样本回归', () => {
  it('样本覆盖 3 条真实截断 + 2 条真实取消', () => {
    expect(realCases).toHaveLength(5)
    expect(realCases.filter((c) => c.kind === 'truncation')).toHaveLength(3)
    expect(realCases.filter((c) => c.kind === 'cancel')).toHaveLength(2)
  })

  for (const testCase of realCases) {
    it(`${testCase.id}：${testCase.labelReason}`, () => {
      const expected = testCase.kind === 'truncation' ? [TRUNCATION_NOTE] : [CANCEL_NOTE]
      expect(buildRiskNotes(testCase.messages, testCase.cancelled)).toEqual(expected)
    })
  }
})

describe('risk notes: 只看事实、不看措辞（删除决策的回归锁）', () => {
  it('正文里满是风险字眼，也一条提示都不出', () => {
    const prose = [
      '这个方案存在风险，而且不确定性很高，confidence 也偏低。',
      '没有任何风险，可以放心上；查不到风险迹象，风险点一个都找不到。',
      '风险不在代码本身，而在于上线后没有人盯日志。',
      'riskNotes 字段目前为空数组。',
    ]
    expect(buildRiskNotes(prose.map((content) => ({ content })), false)).toEqual([])
  })

  it('带截断标志时只出截断提示', () => {
    const notes = buildRiskNotes(
      [
        { content: '这个方案存在风险。' },
        { content: '', truncated: { reason: 'timeout', atMs: 1 } },
      ],
      false,
    )
    expect(notes).toEqual([TRUNCATION_NOTE])
  })

  it('取消时只出取消提示', () => {
    expect(buildRiskNotes([{ content: '顾问的常规回答。' }], true)).toEqual([CANCEL_NOTE])
  })

  it('两个标志同时存在时，截断在前、取消在后（卡片按下标渲染）', () => {
    const notes = buildRiskNotes([{ content: '', truncated: { reason: 'network', atMs: 2 } }], true)
    expect(notes).toEqual([TRUNCATION_NOTE, CANCEL_NOTE])
  })

  it('没有消息、也没有取消时返回空数组', () => {
    expect(buildRiskNotes([], false)).toEqual([])
  })
})
