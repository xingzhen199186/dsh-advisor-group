/**
 * DeepSeek DSML "text tool calls" restorer (0.1.1 slice).
 *
 * Some providers (observed: deepseek-v4-pro via the anthropic-compatible
 * channel) echo their tool requests as plain text instead of structured
 * `tool_use`/`tool_calls` stream events. This single-pass, NON-STREAMING
 * parser recognizes the canonical DSML grammar and the observed variants:
 *
 *   canonical (V4 / V3.2 outer token):
 *     <｜DSML｜tool_calls>            |  <｜DSML｜function_calls>
 *       <｜DSML｜invoke name="f">
 *         <｜DSML｜parameter name="k" string="true">v</｜DSML｜parameter>
 *       </｜DSML｜invoke>
 *     </｜DSML｜tool_calls>
 *
 *   observed variants:
 *     <｜｜tool_calls> / <tool_calls> (optional `｜DSML｜` inside tags),
 *     `<invoke name="f">` / `<parameter name="k" string="true">v</parameter>`
 *     (no `｜DSML｜` prefix, `string` attribute optional, outer block may be
 *     unclosed, block may be glued mid-line to prose).
 *
 * Safety gates (per advisor review): the outer block must be OUTSIDE fenced
 * code blocks ("讲解 DSML 语法"几乎总在围栏里), every `<invoke>` must be CLOSED
 * and its name in the allowed set, every parameter must be fully closed and its
 * value must NOT contain nested `<parameter>` (would make the block boundary
 * ambiguous). On any gate failure the block is left untouched for the existing
 * sanitizer to strip/display.
 *
 * The parser removes the raw markup from the body so the card never shows it,
 * and the restored calls are merged into `toolCalls` by direct-http — they are
 * executed through the SAME official tool pipeline (bounded by
 * runAdvisorToolLoop's MAX_TOOL_ROUNDS and per-invocation idempotency guard).
 */

import type { AdvisorToolCall } from './advisor-tools'

// <｜DSML｜tool_calls> | <｜｜tool_calls> | <tool_calls> | <function_calls>
const OUTER_OPEN = /<[｜|]{0,2}(?:DSML[｜|]{0,2})?(?:tool_calls|function_calls)\s*>/g
const OUTER_CLOSE_RE = /<\/[｜|]{0,2}(?:DSML[｜|]{0,2})?[｜|]{0,2}(?:tool_calls|function_calls)\s*>/
const INVOKE_RE =
  /<[｜|]{0,2}(?:DSML[｜|]{0,2})?[｜|]{0,2}\s*invoke\s+name="([^"]+)">([\s\S]*?)<\/[｜|]{0,2}(?:DSML[｜|]{0,2})?[｜|]{0,2}\s*invoke\s*>/g
const INVOKE_CLOSE_RE = /<\/[｜|]{0,2}(?:DSML[｜|]{0,2})?[｜|]{0,2}\s*invoke\s*>/
const PARAM_RE =
  /<[｜|]{0,2}(?:DSML[｜|]{0,2})?[｜|]{0,2}\s*parameter\s+name="([^"]+)"(?:\s+string="true")?>([\s\S]*?)<\/[｜|]{0,2}(?:DSML[｜|]{0,2})?[｜|]{0,2}\s*parameter\s*>/g
const PARAM_OPEN_RE = /<[｜|]{0,2}(?:DSML[｜|]{0,2})?[｜|]{0,2}\s*parameter\s+name="[^"]+"/g

export interface TextToolCallParse {
  toolCalls: AdvisorToolCall[]
  /** Content with every successfully parsed outer block removed. */
  cleaned: string
}

function insideFence(content: string, index: number): boolean {
  const before = content.slice(0, index)
  const fences = before.match(/```/g)
  return Boolean(fences && fences.length % 2 === 1)
}

/** Parse every invoke inside one outer block; null when any gate fails. */
function parseOuterBlock(block: string, allowedNames: Set<string>): AdvisorToolCall[] | null {
  const calls: AdvisorToolCall[] = []
  INVOKE_RE.lastIndex = 0
  let invoke: RegExpExecArray | null
  let invokeCount = 0
  while ((invoke = INVOKE_RE.exec(block)) !== null) {
    invokeCount += 1
    const name = invoke[1]
    if (!allowedNames.has(name)) return null
    const body = invoke[2]
    const params: Record<string, string> = {}
    PARAM_RE.lastIndex = 0
    let param: RegExpExecArray | null
    let paramCount = 0
    while ((param = PARAM_RE.exec(body)) !== null) {
      paramCount += 1
      // Ambiguous boundary: a nested parameter tag inside the value.
      if (PARAM_OPEN_RE.test(param[2])) return null
      params[param[1]] = param[2]
      PARAM_OPEN_RE.lastIndex = 0
    }
    // Every parameter must have been fully parsed (no partial tag in body).
    if ((body.match(PARAM_OPEN_RE) ?? []).length !== paramCount) return null
    PARAM_OPEN_RE.lastIndex = 0
    calls.push({
      id: `text-${calls.length}`,
      name,
      argumentsJson: paramCount > 0 ? JSON.stringify(params) : '{}',
    })
  }
  if (invokeCount === 0) return null
  return calls
}

/** Extract text tool calls; blocks outside code fences, whitelisted names. */
export function parseTextToolCalls(content: string, allowedNames: Set<string>): TextToolCallParse {
  if (!content || allowedNames.size === 0) return { toolCalls: [], cleaned: content }

  const ranges: Array<[number, number]> = []
  const allCalls: AdvisorToolCall[] = []

  OUTER_OPEN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = OUTER_OPEN.exec(content)) !== null) {
    const start = match.index
    if (insideFence(content, start)) continue
    const rest = content.slice(start)
    const close = rest.match(OUTER_CLOSE_RE)
    const blockText = close && close.index !== undefined ? rest.slice(0, close.index) : rest
    const calls = parseOuterBlock(blockText, allowedNames)
    if (calls === null) continue
    const end = close && close.index !== undefined ? start + close.index + close[0].length : content.length
    allCalls.push(...calls)
    ranges.push([start, end])
  }

  if (allCalls.length === 0) return { toolCalls: [], cleaned: content }

  let cleaned = content
  for (let i = ranges.length - 1; i >= 0; i -= 1) {
    const [from, to] = ranges[i]
    cleaned = cleaned.slice(0, from) + cleaned.slice(to)
  }
  return { toolCalls: allCalls, cleaned: cleaned.trim() }
}
