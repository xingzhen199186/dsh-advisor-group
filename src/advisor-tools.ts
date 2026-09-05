import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { withTimeout } from './providers/timeout'

/** Minimal structural view of the agent (only needed for scope routing). */
export type AdvisorAgent = { session?: unknown; id?: string }

/**
 * Advisor tool calling (2026-09-05): the models in the advisor group may call
 * the tools visible to the CURRENT DSH session (read/grep/glob/web search…)
 * before answering, through the official `ctx.tools` seam — the same scoped
 * registry, guard pipeline and pre/post policies the agent loop uses.
 *
 * Two channel constraints:
 *  - `ctx.llm` (dsh-llm 0.1.2-rc.1) does not support tool-calling, so tool use
 *    requires the DIRECT-http channel (OpenAI-compatible / Anthropic).
 *  - `discussion.advisorTools` = 'readonly' (default, read-only whitelist) |
 *    'all' (every session-visible tool, incl. writable ones) | 'off'.
 */

export type AdvisorToolsMode = 'readonly' | 'all' | 'off'

/** Conservative read-only whitelist for the default advisor tool scope. */
const READONLY_TOOL_NAMES = new Set([
  'read',
  'grep',
  'glob',
  'web_search',
  'web_fetch',
  'scan_discover',
  'list_imported_sessions',
] as const)

/** Model-facing tool schema (the allowlisted projection of ToolSchema). */
export interface AdvisorToolSchema {
  name: string
  description?: string
  parameters?: unknown
}

const MAX_TOOL_ROUNDS = 4
const TOOL_EXEC_TIMEOUT_MS = 30_000
const TOOL_RESULT_MAX_CHARS = 8_000

/** One model-requested tool call. */
export interface AdvisorToolCall {
  id: string
  name: string
  /** Raw argument JSON string as streamed by the model. */
  argumentsJson: string
}

export interface StreamOnceResult {
  content: string
  thinking: string
  toolCalls: AdvisorToolCall[]
  truncated?: { reason: 'timeout' | 'network'; atMs: number }
}

/**
 * Resolve the advisor-visible tool schemas. `agent` (when provided) makes the
 * registry resolve the scoped view — exactly the tools that session's Agent
 * loop serves, honouring presets and restrict() filters.
 */
export function resolveAdvisorToolSchemas(
  ctx: Context,
  agent: AdvisorAgent | undefined,
  mode: AdvisorToolsMode,
): AdvisorToolSchema[] {
  if (mode === 'off') return []
  const tools = (ctx as unknown as { tools?: { schemas?: (scope?: unknown) => unknown[] } }).tools
  const schemas = tools?.schemas?.(agent) ?? []
  let list: unknown[] = schemas
  if (mode === 'readonly') {
    list = schemas.filter(
      (schema) =>
        typeof schema === 'object' &&
        schema !== null &&
        READONLY_TOOL_NAMES.has((schema as { name?: unknown }).name as never),
    )
  }
  return (list as AdvisorToolSchema[]).map((schema) => {
    const { name, description, parameters } = schema as {
      name: string
      description?: string
      parameters?: unknown
    }
    return {
      name,
      ...(typeof description === 'string' ? { description } : {}),
      ...(parameters === undefined ? {} : { parameters }),
    }
  })
}

/** Human-readable one-line summary of a tool result (for the thinking panel). */
export function summarizeToolResult(result: ToolExecutionResult): string {
  let text = ''
  if (result.isError) {
    text = `（错误）${result.error?.message ?? 'unknown'}`
  } else {
    const blocks = result.content ?? []
    text = blocks
      .map((block) => (typeof block === 'object' && block !== null && 'text' in block && typeof block.text === 'string' ? block.text : ''))
      .join('')
      .trim()
    if (!text && result.value !== undefined) {
      try {
        text = JSON.stringify(result.value)
      } catch {
        text = String(result.value)
      }
    }
  }
  return text.length > TOOL_RESULT_MAX_CHARS ? `${text.slice(0, TOOL_RESULT_MAX_CHARS)}…（已截断）` : text
}

/**
 * Execute one tool via the official pipeline (scoped dispatch when `agent` is
 * provided). Returns the model-facing text; never throws.
 */
export async function executeAdvisorTool(
  ctx: Context,
  agent: AdvisorAgent | undefined,
  call: AdvisorToolCall,
  signal?: AbortSignal,
): Promise<string> {
  const tools = (ctx as unknown as {
    tools?: { execute?: (input: unknown) => Promise<ToolExecutionResult> }
  }).tools
  if (!tools?.execute) {
    return '（顾问工具执行不可用：当前环境未提供工具执行服务）'
  }
  let args: unknown = {}
  try {
    args = call.argumentsJson ? JSON.parse(call.argumentsJson) : {}
  } catch {
    return '（工具参数不是合法 JSON）'
  }
  try {
    const result = await tools.execute({
      callId: call.id as never,
      name: call.name,
      arguments: args,
      ...(agent === undefined ? {} : { agent }),
      signal: withTimeout(TOOL_EXEC_TIMEOUT_MS, signal),
    })
    return summarizeToolResult(result)
  } catch (error) {
    return `（工具执行失败：${error instanceof Error ? error.message : String(error)}）`
  }
}

/** One tool step surfaced as its own row (agent-loop style). */
export interface AdvisorToolStepEvent {
  kind: 'call' | 'result'
  name: string
  text: string
}

/**
 * Drive the tool-calling loop: stream with `tools` → execute every
 * model-requested call (each step surfaced via `onToolStep` as its own row) →
 * feed a compact "already executed" block back → repeat until the model
 * answers (or MAX_TOOL_ROUNDS, then one final no-tools round to force a text
 * answer).
 */
export async function runAdvisorToolLoop(
  tools: AdvisorToolSchema[],
  streamOnce: (tools: AdvisorToolSchema[], extraContext: string) => Promise<StreamOnceResult>,
  executeTool: (call: AdvisorToolCall) => Promise<string>,
  onToolStep: (step: AdvisorToolStepEvent) => void,
): Promise<{ content: string; truncated: StreamOnceResult['truncated'] }> {
  let extraContext = ''
  let truncated: StreamOnceResult['truncated']
  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const result = await streamOnce(tools, extraContext)
    if (result.toolCalls.length === 0) {
      return { content: result.content, truncated: result.truncated }
    }
    truncated = result.truncated ?? truncated
    const executed: string[] = []
    for (const call of result.toolCalls) {
      const argsPreview = call.argumentsJson.length > 120 ? `${call.argumentsJson.slice(0, 120)}…` : call.argumentsJson
      onToolStep({ kind: 'call', name: call.name, text: argsPreview || '无参数' })
      const outcome = await executeTool(call)
      if (outcome.trim()) {
        onToolStep({ kind: 'result', name: call.name, text: outcome.replace(/\n+/g, ' ').slice(0, 240).trim() })
      }
      executed.push(`- ${call.name}${call.argumentsJson ? ` 参数：${call.argumentsJson.slice(0, 200)}` : ''}\n结果：${outcome}`)
    }
    extraContext = `${extraContext}\n\n【顾问已执行工具】\n${executed.join('\n\n')}`
  }
  // Max rounds reached: one final round WITHOUT tools to force a textual answer.
  const final = await streamOnce([], extraContext)
  return { content: final.content, truncated: final.truncated ?? truncated }
}
