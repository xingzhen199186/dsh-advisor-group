import type { AdvisorConfig } from '../config'
import { getProviderPreset } from './presets'
import { ADVISOR_OUTPUT_POLICY } from './advisor-prompt'
import { ADVISOR_CALL_TIMEOUT_MS, withTimeout } from './timeout'
import type { TranscriptEntry } from './ctx-llm'

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
}

/** Stream an advisor response through direct HTTP (OpenAI/Anthropic SSE). */
export async function streamDirectHttp(
  advisor: AdvisorConfig,
  transcript: TranscriptEntry[],
  onDelta: (delta: StreamDelta) => void,
  signal?: AbortSignal,
  timeoutMs?: number,
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
      return streamOpenAICompatible(baseURL, advisor, apiKey, transcriptText, onDelta, signal, timeoutMs)
    case 'anthropic':
      return streamAnthropic(baseURL, advisor, apiKey, transcriptText, authMode, onDelta, signal, timeoutMs)
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
): Promise<StreamResult> {
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
      stream: true,
    }),
    signal: withTimeout(timeoutMs ?? ADVISOR_CALL_TIMEOUT_MS, signal),
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

  while (true) {
    let done: boolean
    let value: Uint8Array | undefined
    try {
      const read = await reader.read()
      done = read.done
      value = read.value
    } catch (error) {
      // A mid-stream connection drop keeps the collected partial content;
      // only the caller's abort/timeout signal propagates as cancellation.
      if (signal?.aborted || (error as { name?: string })?.name === 'AbortError') throw error
      break
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
            choices?: Array<{ delta?: { content?: string; reasoning_content?: string; reasoning?: string } }>
          }
          const delta = json.choices?.[0]?.delta ?? {}
          const text = typeof delta.content === 'string' ? delta.content : ''
          const think =
            typeof delta.reasoning_content === 'string'
              ? delta.reasoning_content
              : typeof delta.reasoning === 'string'
                ? delta.reasoning
                : ''
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
  return { content, thinking }
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
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: advisor.model,
      system: advisor.systemPrompt + ADVISOR_OUTPUT_POLICY,
      messages: [{ role: 'user', content: transcriptText }],
      temperature: advisor.temperature ?? 0.3,
      max_tokens: advisor.maxTokens ?? 16384,
      stream: true,
    }),
    signal: withTimeout(timeoutMs ?? ADVISOR_CALL_TIMEOUT_MS, signal),
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

  while (true) {
    let done: boolean
    let value: Uint8Array | undefined
    try {
      const read = await reader.read()
      done = read.done
      value = read.value
    } catch (error) {
      // A mid-stream connection drop keeps the collected partial content;
      // only the caller's abort/timeout signal propagates as cancellation.
      if (signal?.aborted || (error as { name?: string })?.name === 'AbortError') throw error
      break
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
            delta?: { type?: string; text?: string; thinking?: string }
          }
          if (json.type === 'content_block_delta' && json.delta) {
            if (json.delta.type === 'text_delta' && typeof json.delta.text === 'string') {
              content += json.delta.text
              onDelta({ text: json.delta.text })
            } else if (json.delta.type === 'thinking_delta' && typeof json.delta.thinking === 'string') {
              thinking += json.delta.thinking
              onDelta({ thinking: json.delta.thinking })
            }
          }
        } catch {
          // Ignore malformed SSE chunks.
        }
      }
    }
  }
  return { content, thinking }
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
