import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { AdvisorConfig } from '../config'
import type { TruncationInfo } from '../types'
import { ADVISOR_OUTPUT_POLICY } from './advisor-prompt'
import { ADVISOR_CALL_TIMEOUT_MS, timeoutSignalPair } from './timeout'

export interface TranscriptEntry {
  role: 'main' | 'advisor'
  name: string
  content: string
}

export interface CtxLlmDelta {
  text?: string
  thinking?: string
}

export interface CtxLlmResult {
  content: string
  thinking: string
  /** Set when the advisor timeout cut the stream before a complete body. */
  truncated?: TruncationInfo
}

function formatTranscript(entries: TranscriptEntry[]): string {
  return entries
    .map((entry) => `[${entry.role === 'main' ? '主模型' : entry.name}]\n${entry.content}`)
    .join('\n\n')
}

/**
 * Call an advisor through DSH's built-in ctx.llm seam.
 *
 * This is the primary path: it reuses whatever provider routes the user has
 * already configured in DSH (deepseek-official, llm-pi-ai providers, etc.),
 * including credentials resolved by the harness.
 *
 * Timeout semantics (root cause of "thinking cut mid-sentence, no body"): a
 * long-reasoning model can spend the whole advisor budget on its thinking
 * chain. When `timeoutMs` fires, the stream simply stops (it does not throw),
 * which used to produce a silent empty body. We now detect the timeout and
 * report `truncated` so the caller can surface it to the user instead of
 * treating the reply as complete. A caller-initiated abort still propagates.
 */
export async function callViaCtxLlm(
  ctx: Context,
  advisor: AdvisorConfig,
  transcript: TranscriptEntry[],
  signal?: AbortSignal,
  onDelta?: (delta: CtxLlmDelta) => void,
  timeoutMs?: number,
): Promise<CtxLlmResult> {
  const userText = formatTranscript(transcript)
  const messages = [
    createUserMessage({
      content: [{ type: 'text', text: userText }],
      source: { kind: 'plugin', plugin: 'dsh-advisor-group' },
    }),
  ]

  const pair = timeoutSignalPair(timeoutMs ?? ADVISOR_CALL_TIMEOUT_MS, signal)
  const options: GenerateOptions = {
    provider: advisor.provider,
    model: advisor.model,
    system: `${advisor.systemPrompt}${ADVISOR_OUTPUT_POLICY}`,
    messages,
    temperature: advisor.temperature,
    // A hard floor for the reply budget: without it, long-reasoning models can
    // spend everything on the thinking chain and truncate the body (see
    // ADVISOR_OUTPUT_POLICY).
    maxTokens: advisor.maxTokens ?? 16384,
    signal: pair.signal,
  }

  let text = ''
  let thinking = ''
  try {
    for await (const chunk of ctx.llm.stream(options)) {
      if (chunk.type === 'text-delta') {
        text += chunk.text
        onDelta?.({ text: chunk.text })
      } else if (chunk.type === 'reasoning-delta') {
        thinking += chunk.text
        onDelta?.({ thinking: chunk.text })
      }
    }
  } catch (error) {
    if (pair.isTimeout()) {
      return { content: text, thinking, truncated: { reason: 'timeout', atMs: Date.now() } }
    }
    // Caller signal abort (user stop / exec.signal) or provider error: rethrow
    // so the pipeline degrades exactly as before.
    throw error
  }
  if (pair.isTimeout()) {
    return { content: text, thinking, truncated: { reason: 'timeout', atMs: Date.now() } }
  }
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }
  return { content: text, thinking }
}
