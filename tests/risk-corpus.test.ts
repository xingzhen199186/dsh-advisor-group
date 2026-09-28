import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildRiskNotes, CANCEL_NOTE, KEYWORD_RISK_NOTE, TRUNCATION_NOTE } from '../src/risk-notes'
import type { TruncationInfo } from '../src/types'

// 风险语料集指标（冻结验收见 tasks/todo.md「风险语料集指标 实施计划」）：
// 三条规则分口径评分；硬门只约束 holdout 的误报（FP=0），漏报（FN）只报告
// 不设阈值（定位=提示而非检测器）。split 由语料文件字段冻结，测试复算防漂移。

interface CorpusMessage {
  content?: string
  truncated?: TruncationInfo
}

interface CorpusCase {
  id: string
  kind: 'keyword' | 'truncation' | 'cancel'
  source: 'real' | 'adversarial'
  origin: string
  messages: CorpusMessage[]
  cancelled: boolean
  expect: boolean
  labelReason: string
  split: 'dev' | 'holdout'
}

const corpusUrl = new URL('./fixtures/risk-corpus/corpus.jsonl', import.meta.url)
const cases: CorpusCase[] = readFileSync(corpusUrl, 'utf8')
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as CorpusCase)

function fires(testCase: CorpusCase): boolean {
  const notes = buildRiskNotes(testCase.messages, testCase.cancelled)
  if (testCase.kind === 'keyword') return notes.includes(KEYWORD_RISK_NOTE)
  if (testCase.kind === 'truncation') return notes.includes(TRUNCATION_NOTE)
  return notes.includes(CANCEL_NOTE)
}

interface Cell {
  tp: number
  fp: number
  fn: number
  tn: number
}

function emptyCell(): Cell {
  return { tp: 0, fp: 0, fn: 0, tn: 0 }
}

function judge(cell: Cell, expect: boolean, actual: boolean): void {
  if (expect && actual) cell.tp += 1
  else if (!expect && actual) cell.fp += 1
  else if (expect && !actual) cell.fn += 1
  else cell.tn += 1
}

describe('风险语料集指标', () => {
  it('语料结构完整（≥50 条、真实≥15、字段与 split 冻结规则一致）', () => {
    expect(cases.length).toBeGreaterThanOrEqual(50)
    const realCount = cases.filter((c) => c.source === 'real').length
    expect(realCount).toBeGreaterThanOrEqual(15)

    for (const c of cases) {
      expect(c.id).toBeTruthy()
      expect(c.labelReason.length).toBeGreaterThan(0)
      expect(['keyword', 'truncation', 'cancel']).toContain(c.kind)
      expect(['dev', 'holdout']).toContain(c.split)
      expect(c.messages.length).toBeGreaterThan(0)
    }

    // 复算冻结切分：各 kind×expect 内按 id 排序，每第 3 条（下标 %3===2）入 holdout。
    const groups = new Map<string, CorpusCase[]>()
    for (const c of cases) {
      const key = `${c.kind}|${c.expect}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(c)
    }
    for (const list of groups.values()) {
      const sorted = [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      sorted.forEach((c, index) => {
        expect(c.split, `case ${c.id} 的 split 与冻结切分规则不一致`).toBe(
          index % 3 === 2 ? 'holdout' : 'dev',
        )
      })
    }
  })

  it('分口径 × split 混淆矩阵，holdout 误报硬门 FP=0', () => {
    const kinds = ['keyword', 'truncation', 'cancel'] as const
    const splits = ['dev', 'holdout'] as const
    const matrix = new Map<string, Cell>()
    for (const kind of kinds) {
      for (const split of splits) {
        matrix.set(`${kind}|${split}`, emptyCell())
      }
    }

    const fpIds: string[] = []
    const fnIds: string[] = []
    for (const c of cases) {
      const cell = matrix.get(`${c.kind}|${c.split}`)!
      const actual = fires(c)
      if (c.expect && !actual) fnIds.push(c.id)
      if (!c.expect && actual) fpIds.push(c.id)
      judge(cell, c.expect, actual)
    }

    const lines: string[] = []
    for (const kind of kinds) {
      for (const split of splits) {
        const cell = matrix.get(`${kind}|${split}`)!
        const recallBase = cell.tp + cell.fn
        const recall = recallBase > 0 ? `${cell.tp}/${recallBase}` : 'n/a'
        lines.push(
          `[${kind}|${split}] TP=${cell.tp} FP=${cell.fp} FN=${cell.fn} TN=${cell.tn} recall=${recall}`,
        )
      }
    }
    lines.push(`误报(FP)样例：${fpIds.join(', ') || '无'}`)
    lines.push(`漏报(FN)样例：${fnIds.join(', ') || '无'}`)
    console.log('\n' + lines.join('\n'))

    // 冻结硬门：holdout 只允许 0 误报（零误报优先；漏报仅记录）。
    for (const kind of kinds) {
      const holdout = matrix.get(`${kind}|holdout`)!
      expect(holdout.fp, `${kind} 口径 holdout 出现误报`).toBe(0)
    }
  })
})
