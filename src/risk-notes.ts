import type { TruncationInfo } from './types'

export const TRUNCATION_NOTE = '有顾问输出在流式过程中被截断（超时或网络中断），其正文可能不完整，且该顾问本轮可能只提供了部分意见。'
export const CANCEL_NOTE = '本次顾问群讨论已被用户或主模型取消，结论可能不完整。'

// 2026-09-29 用户裁定「删」：移除关键词启发式风险提示（原 KEYWORD_RISK_NOTE）。
// 原规则靠字眼（风险 / 不确定 / confidence …）猜顾问有没有表达保留，v2 又补了一组
// 固定否定串的剥离。冻结盲测（15 条未见样本，跑前按哈希封存、只跑一次）显示它不泛化：
// 10 条新写法的关键词样本里 4 条纯否定句全部误报（4/4），而 3 条真实截断 + 2 条真实
// 取消全部判对。用户据此裁定不再投入 v3，直接删除该规则——只保留由**事实标志**驱动的
// 两条提示（截断 / 取消），它们不会因措辞变化误报。
// 证据与封存记录：tasks/todo.md「盲测集 落盘与冻结记录」；被删规则的最后版本见 git 历史。

interface RiskNoteInputMessage {
  content?: string
  truncated?: TruncationInfo
}

/**
 * 汇总风险提示（两条规则：截断 / 取消）。
 * 判定只看消息上的截断标志与 cancelled 标志，**不读正文**——没有基于文本的猜测，
 * 因此不会误报。content 字段保留在入参类型里只为兼容既有调用方（本函数不再读它）。
 */
export function buildRiskNotes(
  messages: readonly RiskNoteInputMessage[],
  cancelled: boolean,
): string[] {
  const notes: string[] = []
  if (messages.some((message) => message.truncated !== undefined)) {
    notes.push(TRUNCATION_NOTE)
  }
  if (cancelled) {
    notes.push(CANCEL_NOTE)
  }
  return notes
}
