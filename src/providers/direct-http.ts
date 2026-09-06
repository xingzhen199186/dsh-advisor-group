import type { AdvisorConfig } from '../config'
import type { TruncationInfo } from '../types'
import { getProviderPreset } from './presets'
import { ADVISOR_OUTPUT_POLICY } from './advisor-prompt'
import { ADVISOR_CALL_TIMEOUT_MS, timeoutSignalPair, withTimeout } from './timeout'
import type { TranscriptEntry } from './ctx-llm'
import type { AdvisorToolCall, AdvisorToolSchema } from '../advisor-tools'
import { parseTextToolCalls } from '../dsml'

type AdvisorThinkingEffort = 'off' | 'low' | 'high' | 'max'

/** True when the user asked to force thinking off, through either spelling. */
function thinkingOff(advisor: AdvisorConfig): boolean {
  return advisor.thinking === 'disabled' || advisor.reasoningEffort === 'off'
}

/**
 * OpenAI-compatible reasoning params, provider-aware (2026-09-05 知识 X 最新):
 * - DeepSeek: `thinking {type}` switch + `reasoning_effort` low/high/max.
 * - Kimi/Kimi Code: kimi-k3 = top-level `reasoning_effort` low/high/max (no
 *   `thinking`); kimi-k2.7-code = always thinking, no params; kimi-k2.6 =
 *   `thinking {type}` switch only.
 * - OpenAI official: `reasoning_effort` minimal|low|medium|high (no max, no off).
 * - 阿里云百炼: `enable_thinking` bool (Qwen chat completions).
 * - 智谱: `thinking {type}` switch + `reasoning_effort` (GLM-5.3 force-enabled,
 *   disabled→enabled+low; GLM-5.2/5.1/5 can disable).
 * - 硅基流动: `enable_thinking` + `thinking_budget`.
 * - Others (AIHubMix/OpenRouter/custom): best-effort `reasoning_effort`.
 */
function openAiThinkingParams(advisor: AdvisorConfig): Record<string, unknown> {
  const provider = advisor.provider
  const model = advisor.model
  const effort = advisor.reasoningEffort

  if (provider === 'deepseek') {
    if (thinkingOff(advisor)) return { thinking: { type: 'disabled' } }
    return {
      ...(advisor.thinking === 'enabled' ? { thinking: { type: 'enabled' } } : {}),
      ...(effort && effort !== 'off' ? { reasoning_effort: effort } : {}),
    }
  }

  if (provider === 'moonshot' || provider === 'kimi-code') {
    if (/^(k3|kimi-k3)(-|$)/i.test(model)) {
      // kimi-k3 always reasons; strength via top-level reasoning_effort.
      if (effort && effort !== 'off') return { reasoning_effort: effort }
      return {}
    }
    if (/kimi-k2\.7-code|kimi-for-coding/i.test(model)) {
      // Always thinking; no thinking/reasoning_effort params accepted.
      return {}
    }
    // kimi-k2.6 and older: thinking switch only.
    if (advisor.thinking === 'disabled') return { thinking: { type: 'disabled' } }
    if (advisor.thinking === 'enabled') return { thinking: { type: 'enabled' } }
    return {}
  }

  if (provider === 'openai') {
    if (effort === 'low') return { reasoning_effort: 'low' }
    if (effort === 'high' || effort === 'max') return { reasoning_effort: 'high' }
    return {}
  }

  if (provider === 'bailian' || provider === 'bailian-openai-singapore' || provider === 'bailian-openai-us') {
    // DashScope OpenAI-compatible: enable_thinking bool toggles Qwen thinking.
    if (thinkingOff(advisor)) return { enable_thinking: false }
    if (advisor.thinking === 'enabled') return { enable_thinking: true }
    return {}
  }

  if (provider === 'zhipu') {
    if (/glm-5\.3/i.test(model)) {
      // GLM-5.3/5.3-FLASH force thinking; disabled would 400. Migrate off→low.
      return {
        thinking: { type: 'enabled' },
        reasoning_effort: thinkingOff(advisor)
          ? 'low'
          : effort && effort !== 'off'
            ? effort
            : 'max',
      }
    }
    if (/glm-5/i.test(model)) {
      // GLM-5.2/5.1/5/5-turbo/5v-turbo: switch + effort.
      if (thinkingOff(advisor)) return { thinking: { type: 'disabled' } }
      return {
        ...(advisor.thinking === 'enabled' ? { thinking: { type: 'enabled' } } : {}),
        ...(effort && effort !== 'off' ? { reasoning_effort: effort } : {}),
      }
    }
    // Older GLM (4.6/4.5): thinking switch only.
    if (advisor.thinking === 'disabled') return { thinking: { type: 'disabled' } }
    if (advisor.thinking === 'enabled') return { thinking: { type: 'enabled' } }
    return {}
  }

  if (provider === 'siliconflow') {
    if (thinkingOff(advisor)) return { enable_thinking: false }
    const budget =
      effort === 'low' ? 1024 : effort === 'high' ? 8192 : effort === 'max' ? 16384 : 0
    return {
      ...(advisor.thinking === 'enabled' || budget > 0 ? { enable_thinking: true } : {}),
      ...(budget > 0 ? { thinking_budget: budget } : {}),
    }
  }

  // aihubmix / openrouter / custom
  if (effort && effort !== 'off') return { reasoning_effort: effort }
  return {}
}

/** Anthropic Messages reasoning params, provider-aware.
 *  Official Anthropic: adaptive (`thinking:{type:'adaptive'}` + `output_config.effort`)
 *  for Opus 4.6/4.7/Sonnet 4.6/Mythos; manual `enabled`+`budget_tokens` for older
 *  models. DeepSeek's Anthropic-compatible endpoint uses `reasoning.effort` +
 *  `output_config.effort` (its `budget_tokens` is ignored). Other Anthropic skins
 *  follow the official Anthropic wire shape. */
function anthropicThinkingParams(advisor: AdvisorConfig): Record<string, unknown> {
  const provider = advisor.provider
  if (provider === 'deepseek-anthropic') {
    if (thinkingOff(advisor)) return { reasoning: { effort: 'none' } }
    if (advisor.reasoningEffort && advisor.reasoningEffort !== 'off') {
      return {
        reasoning: { effort: advisor.reasoningEffort },
        output_config: { effort: advisor.reasoningEffort },
      }
    }
    return {}
  }
  if (thinkingOff(advisor)) return { thinking: { type: 'disabled' } }
  if (advisor.reasoningEffort && advisor.reasoningEffort !== 'off') {
    const adaptive = /(?:opus-4-[6-8]|opus-5|sonnet-4-6|sonnet-5|fable|mythos)/i.test(advisor.model)
    if (adaptive) {
      return {
        thinking: { type: 'adaptive' },
        output_config: { effort: advisor.reasoningEffort },
      }
    }
    const budget =
      advisor.reasoningEffort === 'low'
        ? 2048
        : advisor.reasoningEffort === 'high'
          ? 8192
          : 16384
    return { thinking: { type: 'enabled', budget_tokens: budget } }
  }
  return {}
}

/** Gemini `generateContent` thinking config. Disabling thinking uses
 *  `thinkingBudget: 0` (NOT `includeThoughts:false`, which only hides returned
 *  thoughts). Effort uses `thinkingBudget`, the backward-compatible knob that
 *  works across Gemini 2.5 and Gemini 3 per Google's migration note. */
function geminiThinkingParams(advisor: AdvisorConfig): Record<string, unknown> {
  if (thinkingOff(advisor)) return { thinkingConfig: { thinkingBudget: 0 } }
  const budget =
    advisor.reasoningEffort === 'low'
      ? 1024
      : advisor.reasoningEffort === 'high'
        ? 8192
        : advisor.reasoningEffort === 'max'
          ? 16384
          : 0
  if (budget > 0) return { thinkingConfig: { thinkingBudget: budget } }
  return {}
}

/** Validate the per-advisor thinking fields at the direct-http boundary so a
 *  malformed stored config fails loudly instead of silently ignoring. */
function assertThinkingParams(advisor: AdvisorConfig): void {
  if (
    advisor.thinking !== undefined &&
    advisor.thinking !== 'enabled' &&
    advisor.thinking !== 'disabled'
  ) {
    throw new Error(`Unsupported thinking mode: ${String(advisor.thinking)}`)
  }
  if (
    advisor.reasoningEffort !== undefined &&
    !(['off', 'low', 'high', 'max'] as const).includes(advisor.reasoningEffort as AdvisorThinkingEffort)
  ) {
    throw new Error(`Unsupported reasoningEffort: ${String(advisor.reasoningEffort)}`)
  }
}

/**
 * Fallback direct HTTP client for providers that are not (yet) configured in
 * DSH's ctx.llm / llm-pi-ai. It supports the three protocol families needed by
 * the target provider list: OpenAI-compatible chat, Anthropic Messages, and
 * Google Gemini generateContent.
 */
export async function callDirectHttp(
  advisor: AdvisorConfig,
  transcript: TranscriptEntry[],
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<string> {
  const preset = advisor.provider ? getProviderPreset(advisor.provider) : undefined
  const baseURL = (advisor.baseURL ?? preset?.baseURL ?? '').replace(/\/+$/, '')
  const apiKey = advisor.apiKey ?? process.env[advisor.apiKeyEnv ?? preset?.apiKeyEnv ?? ''] ?? ''
  const protocol = advisor.protocol ?? preset?.protocol ?? 'openai'
  const authMode = advisor.authMode ?? preset?.authMode ?? 'x-api-key'
  assertThinkingParams(advisor)

  if (!baseURL || !apiKey) {
    throw new Error(`Direct HTTP fallback is not configured for advisor "${advisor.name}" (${advisor.provider}). Add baseURL/apiKey or configure the provider in DSH.`)
  }

  const transcriptText = transcript
    .map((entry) => `[${entry.role === 'main' ? '主模型' : entry.name}]\n${entry.content}`)
    .join('\n\n')

  switch (protocol) {
    case 'openai':
      return callOpenAICompatible(baseURL, advisor, apiKey, transcriptText, signal, timeoutMs)
    case 'anthropic':
      return callAnthropic(baseURL, advisor, apiKey, transcriptText, signal, authMode, timeoutMs)
    case 'gemini':
      return callGemini(baseURL, advisor, apiKey, transcriptText, signal, timeoutMs)
    default:
      throw new Error(`Unsupported protocol: ${String(protocol)}`)
  }
}

export interface StreamDelta {
  text?: string
  thinking?: string
}

export interface StreamResult {
  content: string
  thinking: string
  /** Model-requested tool calls (tool-calling round). */
  toolCalls?: AdvisorToolCall[]
  /** Set when timeout/network cut the stream before a complete body. */
  truncated?: TruncationInfo
}

/** Stream an advisor response through direct HTTP (OpenAI/Anthropic SSE). */
export async function streamDirectHttp(
  advisor: AdvisorConfig,
  transcript: TranscriptEntry[],
  onDelta: (delta: StreamDelta) => void,
  signal?: AbortSignal,
  timeoutMs?: number,
  tools?: AdvisorToolSchema[],
  /** Whitelist for the text tool-call restorer; defaults to `tools` names.
   *  The final forced round sends `tools=[]` but must STILL restore the model's
   *  DSML/text echoes against the advisor's full tool set. */
  parseToolNames?: string[],
): Promise<StreamResult> {
  const preset = advisor.provider ? getProviderPreset(advisor.provider) : undefined
  const baseURL = (advisor.baseURL ?? preset?.baseURL ?? '').replace(/\/+$/, '')
  const apiKey = advisor.apiKey ?? process.env[advisor.apiKeyEnv ?? preset?.apiKeyEnv ?? ''] ?? ''
  const protocol = advisor.protocol ?? preset?.protocol ?? 'openai'
  const authMode = advisor.authMode ?? preset?.authMode ?? 'x-api-key'
  assertThinkingParams(advisor)

  if (!baseURL || !apiKey) {
    throw new Error(`Direct HTTP fallback is not configured for advisor "${advisor.name}" (${advisor.provider}). Add baseURL/apiKey or configure the provider in DSH.`)
  }

  const transcriptText = transcript
    .map((entry) => `[${entry.role === 'main' ? '主模型' : entry.name}]\n${entry.content}`)
    .join('\n\n')

  let result: StreamResult
  switch (protocol) {
    case 'openai':
      result = await streamOpenAICompatible(baseURL, advisor, apiKey, transcriptText, onDelta, signal, timeoutMs, tools)
      break
    case 'anthropic':
      result = await streamAnthropic(baseURL, advisor, apiKey, transcriptText, authMode, onDelta, signal, timeoutMs, tools)
      break
    case 'gemini': {
      const content = await callGemini(baseURL, advisor, apiKey, transcriptText, signal, timeoutMs)
      onDelta({ text: content })
      result = { content, thinking: '' }
      break
    }
    default:
      throw new Error(`Unsupported protocol: ${String(protocol)}`)
  }

  // Text tool-call restore: when the provider echoed its tool requests as plain
  // DSML/text instead of structured stream events, parse them, remove the raw
  // markup from the body (so the card never shows it) and merge the calls into
  // `toolCalls` — runAdvisorToolLoop executes them through the official
  // pipeline (with the same per-invocation idempotency guard).
  const parsed = parseTextToolCalls(
    result.content,
    new Set(parseToolNames ?? (tools ?? []).map((tool) => tool.name)),
  )
  if (parsed.toolCalls.length > 0) {
    console.warn(
      `[dsh-advisor-group] 检测到文本工具调用（DSML/非结构流），已还原并交给 runAdvisorToolLoop 执行：` +
        `${parsed.toolCalls.map((tool) => tool.name).join('、')}`,
    )
    // Merge restored text tool calls with any structured stream calls so the
    // caller executes them through the SAME official pipeline. `cleaned`
    // removes the raw DSML markup from the body (card never shows it).
    return {
      ...result,
      content: parsed.cleaned,
      toolCalls: [...(result.toolCalls ?? []), ...parsed.toolCalls],
    }
  }
  return result
}

async function streamOpenAICompatible(
  baseURL: string,
  advisor: AdvisorConfig,
  apiKey: string,
  transcriptText: string,
  onDelta: (delta: StreamDelta) => void,
  signal?: AbortSignal,
  timeoutMs?: number,
  tools?: AdvisorToolSchema[],
): Promise<StreamResult> {
  const endpoint = baseURL.endsWith('/chat/completions')
    ? baseURL
    : `${baseURL.replace(/\/+$/, '')}/chat/completions`
  const pair = timeoutSignalPair(timeoutMs ?? ADVISOR_CALL_TIMEOUT_MS, signal)
  const body: Record<string, unknown> = {
    model: advisor.model,
    messages: [
      { role: 'system', content: advisor.systemPrompt + ADVISOR_OUTPUT_POLICY },
      { role: 'user', content: transcriptText },
    ],
    temperature: advisor.temperature ?? 0.3,
    max_tokens: advisor.maxTokens ?? 16384,
    ...openAiThinkingParams(advisor),
    stream: true,
  }
  if (tools && tools.length > 0) {
    body.tools = tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        parameters: tool.parameters ?? { type: 'object' },
      },
    }))
  }
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: pair.signal,
  })
  if (!response.ok) {
    throw new Error(`OpenAI-compatible request failed: ${response.status} ${await response.text()}`)
  }
  if (!response.body) throw new Error('OpenAI-compatible response has no body')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let thinking = ''
  // Tool calls: streamed per index (id/name/arguments fragments).
  const toolCalls = new Map<number, { id: string; name: string; args: string }>()

  while (true) {
    let done: boolean
    let value: Uint8Array | undefined
    try {
      const read = await reader.read()
      done = read.done
      value = read.value
    } catch (error) {
      // Diagnostics for the mysterious mid-stream abort (~90s, provider B):
      // record the exact error name/message so the next reproduction can be
      // traced (curl vs adapter vs fetch) from the web log.
      const errName = (error as { name?: string })?.name ?? 'UnknownError'
      const errMessage = error instanceof Error ? error.message : String(error)
      console.warn(
        `[dsh-advisor-group] direct-http stream read error: name=${errName} msg=${errMessage} ` +
          `isTimeout=${pair.isTimeout()} signalAborted=${signal?.aborted ?? false} ` +
          `collectedChars=${content.length + thinking.length}`,
      )
      // Timeout: keep the partial thinking chain and mark the truncation so
      // the caller can surface it (the stream "just stops" otherwise).
      if (pair.isTimeout()) {
        return { content, thinking, toolCalls: collectToolCalls(toolCalls), truncated: { reason: 'timeout', atMs: Date.now() } }
      }
      // Caller signal (user stop / exec.signal): propagate as cancellation.
      if (signal?.aborted || (error as { name?: string })?.name === 'AbortError') throw error
      // Mid-stream network drop: keep the partial content, mark truncation.
      return { content, thinking, toolCalls: collectToolCalls(toolCalls), truncated: { reason: 'network', atMs: Date.now() } }
    }
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let sep: number
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        try {
          const json = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string; reasoning_content?: string; reasoning?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } }>
          }
          const delta = json.choices?.[0]?.delta ?? {}
          const text = typeof delta.content === 'string' ? delta.content : ''
          const think =
            typeof delta.reasoning_content === 'string'
              ? delta.reasoning_content
              : typeof delta.reasoning === 'string'
                ? delta.reasoning
                : ''
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0
              const current = toolCalls.get(idx) ?? { id: '', name: '', args: '' }
              if (tc.id) current.id = tc.id
              if (tc.function?.name) current.name = tc.function.name
              if (tc.function?.arguments) current.args += tc.function.arguments
              toolCalls.set(idx, current)
            }
          }
          if (text) {
            content += text
            onDelta({ text })
          }
          if (think) {
            thinking += think
            onDelta({ thinking: think })
          }
        } catch {
          // Ignore malformed SSE chunks.
        }
      }
    }
  }
  return { content, thinking, toolCalls: collectToolCalls(toolCalls) }
}

/** Map<index, {id,name,args}> → model-facing tool call list. */
function collectToolCalls(
  byIndex: Map<number, { id: string; name: string; args: string }>,
): AdvisorToolCall[] | undefined {
  const calls: AdvisorToolCall[] = []
  for (const [, current] of byIndex) {
    if (!current.name) continue
    calls.push({ id: current.id || `tool-${calls.length}`, name: current.name, argumentsJson: current.args })
  }
  return calls.length > 0 ? calls : undefined
}

async function streamAnthropic(
  baseURL: string,
  advisor: AdvisorConfig,
  apiKey: string,
  transcriptText: string,
  authMode: 'x-api-key' | 'bearer',
  onDelta: (delta: StreamDelta) => void,
  signal?: AbortSignal,
  timeoutMs?: number,
  tools?: AdvisorToolSchema[],
): Promise<StreamResult> {
  const endpoint = baseURL.endsWith('/v1/messages')
    ? baseURL
    : baseURL.endsWith('/v1')
      ? `${baseURL}/messages`
      : `${baseURL.replace(/\/+$/, '')}/v1/messages`
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
  }
  if (authMode === 'bearer') {
    headers['authorization'] = `Bearer ${apiKey}`
  } else {
    headers['x-api-key'] = apiKey
  }
  const body: Record<string, unknown> = {
    model: advisor.model,
    system: advisor.systemPrompt + ADVISOR_OUTPUT_POLICY,
    messages: [{ role: 'user', content: transcriptText }],
    temperature: advisor.temperature ?? 0.3,
    max_tokens: advisor.maxTokens ?? 16384,
    ...anthropicThinkingParams(advisor),
    stream: true,
  }
  if (tools && tools.length > 0) {
    body.tools = tools.map((tool) => ({
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      input_schema: tool.parameters ?? { type: 'object' },
    }))
  }
  const pair = timeoutSignalPair(timeoutMs ?? ADVISOR_CALL_TIMEOUT_MS, signal)
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: pair.signal,
  })
  if (!response.ok) {
    throw new Error(`Anthropic request failed: ${response.status} ${await response.text()}`)
  }
  if (!response.body) throw new Error('Anthropic response has no body')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let thinking = ''
  let currentTool: { id: string; name: string; args: string } | null = null
  let activeTool = false
  const toolCalls: AdvisorToolCall[] = []

  while (true) {
    let done: boolean
    let value: Uint8Array | undefined
    try {
      const read = await reader.read()
      done = read.done
      value = read.value
    } catch (error) {
      const errName = (error as { name?: string })?.name ?? 'UnknownError'
      const errMessage = error instanceof Error ? error.message : String(error)
      console.warn(
        `[dsh-advisor-group] anthropic stream read error: name=${errName} msg=${errMessage} ` +
          `isTimeout=${pair.isTimeout()} signalAborted=${signal?.aborted ?? false} ` +
          `collectedChars=${content.length + thinking.length}`,
      )
      if (pair.isTimeout()) {
        return { content, thinking, toolCalls: toolCalls.length > 0 ? toolCalls : undefined, truncated: { reason: 'timeout', atMs: Date.now() } }
      }
      if (signal?.aborted || (error as { name?: string })?.name === 'AbortError') throw error
      return { content, thinking, toolCalls: toolCalls.length > 0 ? toolCalls : undefined, truncated: { reason: 'network', atMs: Date.now() } }
    }
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let sep: number
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data) continue
        try {
          const json = JSON.parse(data) as {
            type?: string
            index?: number
            content_block?: { type?: string; id?: string; name?: string }
            delta?: { type?: string; text?: string; thinking?: string; partial_json?: string }
          }
          if (json.type === 'content_block_start' && json.content_block?.type === 'tool_use') {
            currentTool =
              currentTool === null
                ? { id: json.content_block.id ?? '', name: json.content_block.name ?? '', args: '' }
                : currentTool
            activeTool = true
          } else if (json.type === 'content_block_delta' && json.delta) {
            if (json.delta.type === 'text_delta' && typeof json.delta.text === 'string') {
              content += json.delta.text
              onDelta({ text: json.delta.text })
            } else if (json.delta.type === 'thinking_delta' && typeof json.delta.thinking === 'string') {
              thinking += json.delta.thinking
              onDelta({ thinking: json.delta.thinking })
            } else if (json.delta.type === 'input_json_delta' && typeof json.delta.partial_json === 'string') {
              if (currentTool) currentTool.args += json.delta.partial_json
            }
          } else if (json.type === 'content_block_stop') {
            if (activeTool && currentTool) {
              toolCalls.push({ id: currentTool.id, name: currentTool.name, argumentsJson: currentTool.args })
              currentTool = null
              activeTool = false
            }
          }
        } catch {
          // Ignore malformed SSE chunks.
        }
      }
    }
  }
  return { content, thinking, toolCalls: toolCalls.length > 0 ? toolCalls : undefined }
}

async function callOpenAICompatible(
  baseURL: string,
  advisor: AdvisorConfig,
  apiKey: string,
  transcriptText: string,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<string> {
  const endpoint = baseURL.endsWith('/chat/completions')
    ? baseURL
    : `${baseURL.replace(/\/+$/, '')}/chat/completions`
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: advisor.model,
      messages: [
        { role: 'system', content: advisor.systemPrompt + ADVISOR_OUTPUT_POLICY },
        { role: 'user', content: transcriptText },
      ],
      temperature: advisor.temperature ?? 0.3,
      max_tokens: advisor.maxTokens ?? 16384,
      ...openAiThinkingParams(advisor),
      stream: false,
    }),
    signal: withTimeout(timeoutMs ?? ADVISOR_CALL_TIMEOUT_MS, signal),
  })
  if (!response.ok) {
    throw new Error(`OpenAI-compatible request failed: ${response.status} ${await response.text()}`)
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  return data.choices?.[0]?.message?.content ?? ''
}

async function callAnthropic(
  baseURL: string,
  advisor: AdvisorConfig,
  apiKey: string,
  transcriptText: string,
  signal?: AbortSignal,
  authMode: 'x-api-key' | 'bearer' = 'x-api-key',
  timeoutMs?: number,
): Promise<string> {
  const endpoint = baseURL.endsWith('/v1/messages')
    ? baseURL
    : baseURL.endsWith('/v1')
      ? `${baseURL}/messages`
      : `${baseURL.replace(/\/+$/, '')}/v1/messages`
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
  }
  if (authMode === 'bearer') {
    headers['authorization'] = `Bearer ${apiKey}`
  } else {
    headers['x-api-key'] = apiKey
  }
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: advisor.model,
      system: advisor.systemPrompt + ADVISOR_OUTPUT_POLICY,
      messages: [{ role: 'user', content: transcriptText }],
      temperature: advisor.temperature ?? 0.3,
      max_tokens: advisor.maxTokens ?? 16384,
      ...anthropicThinkingParams(advisor),
    }),
    signal: withTimeout(timeoutMs ?? ADVISOR_CALL_TIMEOUT_MS, signal),
  })
  if (!response.ok) {
    throw new Error(`Anthropic request failed: ${response.status} ${await response.text()}`)
  }
  const data = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>
  }
  return data.content?.map((block) => block.text ?? '').join('') ?? ''
}

async function callGemini(
  baseURL: string,
  advisor: AdvisorConfig,
  apiKey: string,
  transcriptText: string,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<string> {
  const model = encodeURIComponent(advisor.model)
  const base = baseURL.replace(/\/+$/, '')
  const endpoint = base.endsWith('/v1beta')
    ? `${base}/models/${model}:generateContent?key=${apiKey}`
    : `${base}/v1beta/models/${model}:generateContent?key=${apiKey}`
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: transcriptText }] }],
      systemInstruction: { parts: [{ text: advisor.systemPrompt + ADVISOR_OUTPUT_POLICY }] },
      generationConfig: {
        temperature: advisor.temperature ?? 0.3,
        maxOutputTokens: advisor.maxTokens ?? 16384,
        ...geminiThinkingParams(advisor),
      },
    }),
    signal: withTimeout(timeoutMs ?? ADVISOR_CALL_TIMEOUT_MS, signal),
  })
  if (!response.ok) {
    throw new Error(`Gemini request failed: ${response.status} ${await response.text()}`)
  }
  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  }
  return data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? ''
}
