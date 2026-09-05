/**
 * Standard suffix appended to every advisor system prompt.
 *
 * It asks the advisor to state its own confidence/uncertainty so the main
 * model can weigh the answer instead of treating all advisor output equally.
 */
export const ADVISOR_OUTPUT_POLICY = `

回答要求：
- 先给结论，再简要说明依据；
- 在回答末尾用一行标注：置信度（0-10）或不确定性；
- 如果没有把握，请明确写“不确定”，不要强行编造；
- 思考（思维链）请保持精简：只列关键推理要点，切勿让思考链占满输出预算——必须保证正文完整（历史教训：长思考+长上下文会耗尽输出上限，导致正文丢失/中途截断）。
`

/**
 * Tool-calling guidance appended to an advisor's system prompt ONLY when the
 * advisor actually has tools configured and the session-visible set resolved
 * (callAdvisor adds it on the direct-http tool loop path).
 */
export const ADVISOR_TOOL_GUIDANCE = `

工具使用指引：
- 你可以调用当前会话提供的工具（检索/读取/搜索等）来辅助回答；
- 对于你不了解、不熟悉的内容，尤其是项目背景、代码细节、仓库状态等不在你知识范围内的情况，请优先使用联网工具（如 web_search、web_fetch）搜索核实，再基于实际信息给出意见；
- 仅在确有必要时调用工具：先了解现状，再下结论；不要编造你未核实的事实。
`

/**
 * Sequential-relay role hint appended to one advisor's system prompt.
 *
 * The first advisor answers the (main-model) question directly; every later
 * advisor joins the same turn AFTER its predecessors and is told to give its
 * OWN view against the full conversation (agree / complement / rebut), so the
 * turn reads as main-question → A → B(sees A) → C(sees A+B).
 */
export function advisorJoinPrompt(joinIndex: number, advisorCount: number): string {
  if (joinIndex <= 1) {
    return `
本次你作为第 1 位接入的顾问：请直接、完整地回答主模型的问题；你在本轮中会最先发言，后续其他顾问会基于你的回答继续补充。
`
  }
  return `
本次你作为第 ${joinIndex} / ${advisorCount} 位接入的顾问。你可以在上下文中看到：
- 项目背景与主模型的问题；
- 前面已接入顾问（第 1 至第 ${joinIndex - 1} 位）对本问题的完整回答。

请给出你**自己的独立见解**：可以认同、补充、质疑或反驳前面顾问的观点，但请明确点出你的回答与前序观点的差异和理由；不要简单复述前序内容。
`
}