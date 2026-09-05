import type { AdvisorConfig } from '../config'
import type { TruncationInfo } from '../types'
import { getProviderPreset } from './presets'
import { ADVISOR_OUTPUT_POLICY } from './advisor-prompt'
import { ADVISOR_CALL_TIMEOUT_MS, timeoutSignalPair, withTimeout } from './timeout'
import type { TranscriptEntry } from './ctx-llm'
import type { AdvisorToolCall, AdvisorToolSchema } from '../advisor-tools'

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
): Promise<StreamResult> {
  const preset = advisor.provider ? getProviderPreset(advisor.provider) : undefined
  const baseURL = (advisor.baseURL ?? preset?.baseURL ?? '').replace(/\/+$/, '')
  const apiKey = advisor.apiKey ?? process.env[advisor.apiKeyEnv ?? preset?.apiKeyEnv ?? ''] ?? ''
  const protocol = advisor.protocol ?? preset?.protocol ?? 'openai'
  const authMode = advisor.authMode ?? preset?.authMode ?? 'x-api-key'

  if (!baseURL || !apiKey) {
    throw new Error(`Direct HTTP fallback is not configured for advisor "${advisor.name}" (${advisor.provider}). Add baseURL/apiKey or configure the provider in DSH.`)
  }

  const transcriptText = transcript
    .map((entry) => `[${entry.role === 'main' ? '主模型' : entry.name}]\n${entry.content}`)
    .join('\n\n')

  switch (protocol) {
    case 'openai':
      return streamOpenAICompatible(baseURL, advisor, apiKey, transcriptText, onDelta, signal, timeoutMs, tools)
    case 'anthropic':
      return streamAnthropic(baseURL, advisor, apiKey, transcriptText, authMode, onDelta, signal, timeoutMs, tools)
    case 'gemini': {
      const content = await callGemini(baseURL, advisor, apiKey, transcriptText, signal, timeoutMs)
      onDelta({ text: content })
      return { content, thinking: '' }
    }
    default:
      throw new Error(`Unsupported protocol: ${String(protocol)}`)
  }
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
