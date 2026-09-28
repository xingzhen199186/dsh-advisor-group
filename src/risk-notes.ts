import type { TruncationInfo } from './types'

/** 黄金关键词提示（riskNotes[0]），既有测试按字节比对。 */
export const KEYWORD_RISK_NOTE = '部分顾问提到了风险、不确定性或置信度较低，请主模型谨慎采用。'
export const TRUNCATION_NOTE = '有顾问输出在流式过程中被截断（超时或网络中断），其正文可能不完整，且该顾问本轮可能只提供了部分意见。'
export const CANCEL_NOTE = '本次顾问群讨论已被用户或主模型取消，结论可能不完整。'

// v2（风险语料集实测驱动，见 tests/risk-corpus.test.ts）：
// 1) 不再把「注意」当风险词——黄金提示文案本身只承诺"风险、不确定性、置信度较低"
//    三类，且语料实测"注意"多为格式提醒/观察义，是主要误报来源；
// 2) ASCII 词加边界，排除 riskNotes、confidenceThreshold 这类标识符里的子串；
// 3) 否定式断言先整段剔除再判词表（"没有任何风险""no risk"不构成提示）。
const RISK_PATTERN =
  /风险|不确定|(?<![A-Za-z0-9_])risk(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])uncertain(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])confidence(?![A-Za-z0-9_])/i

const NEGATED_RISK_PATTERN =
  /没有任何风险|没有(?:任何)?风险|不存在(?:任何)?风险|无风险|风险(?:为|是)(?:零|0)|零风险|no\s+risk/gi

interface RiskNoteInputMessage {
  content?: string
  truncated?: TruncationInfo
}

/**
 * 汇总风险提示（三条规则：关键词 / 截断 / 取消）。
 * 从 AdvisorGroupService.buildSummary 原样抽出，生产与语料测试走同一条
 * 实现（避免测试测到第二份复刻、与真实规则漂移）。判定只看 content，
 * 不看 thinking，与原实现一致；字符串三则与抽出前逐字节相同。
 */
export function buildRiskNotes(
  messages: readonly RiskNoteInputMessage[],
  cancelled: boolean,
): string[] {
  const notes: string[] = []
  const keywordHit = messages.some((message) =>
    RISK_PATTERN.test((message.content ?? '').replace(NEGATED_RISK_PATTERN, '')),
  )
  if (keywordHit) {
    notes.push(KEYWORD_RISK_NOTE)
  }
  if (messages.some((message) => message.truncated !== undefined)) {
    notes.push(TRUNCATION_NOTE)
  }
  if (cancelled) {
    notes.push(CANCEL_NOTE)
  }
  return notes
}
