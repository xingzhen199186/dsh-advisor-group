import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AdvisorConfig } from '../config'
import { ADVISOR_OUTPUT_POLICY } from './advisor-prompt'
import { ADVISOR_CALL_TIMEOUT_MS, withTimeout } from './timeout'

export interface TranscriptEntry {
  role: 'main' | 'advisor'
  name: string
  content: string
}

export interface CtxLlmDelta {
  text?: string
  thinking?: string
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
 */
export async function callViaCtxLlm(
  ctx: Context,
  advisor: AdvisorConfig,
  transcript: TranscriptEntry[],
  signal?: AbortSignal,
  onDelta?: (delta: CtxLlmDelta) => void,
  timeoutMs?: number,
): Promise<string> {
  const userText = formatTranscript(transcript)
  const messages = [
    createUserMessage({
      content: [{ type: 'text', text: userText }],
      source: { kind: 'plugin', plugin: 'dsh-advisor-group' },
    }),
  ]

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
    signal: withTimeout(timeoutMs ?? ADVISOR_CALL_TIMEOUT_MS, signal),
  }

  let text = ''
  for await (const chunk of ctx.llm.stream(options)) {
    if (chunk.type === 'text-delta') {
      text += chunk.text
      onDelta?.({ text: chunk.text })
    } else if (chunk.type === 'reasoning-delta') {
      onDelta?.({ thinking: chunk.text })
    }
  }
  return text
}

/** Re-exported for callers that need to inspect chunk types. */
export type { StreamChunk }
