import { promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Classifier shadow samples (JSONL, append-only).
 *
 * Every non-forced classification the ask_advisors tool runs appends one
 * sample here — the question text (truncated for storage), the self-assessed
 * confidence, the verdict, and whether the consultation actually launched.
 * This is the ground truth for tuning `confidenceThreshold` and the rule
 * sets with real usage data; it never influences behavior.
 */

export interface ShadowSample {
  /** Unix epoch ms. */
  ts: number
  /** Question text, truncated to 200 chars for storage. */
  question: string
  /** Main-model self-assessed confidence (0-1), when supplied. */
  confidence?: number
  shouldEscalate: boolean
  reason: string
  suggestWebSearch: boolean
  /** Whether a consultation was actually launched by the tool. */
  launched: boolean
}

export const SHADOW_QUESTION_LIMIT = 200

/** Pure projection used by tests and storage: truncates and normalizes a sample. */
export function formatShadowSample(sample: ShadowSample): ShadowSample {
  return {
    ...sample,
    ts: Number.isSafeInteger(sample.ts) ? sample.ts : Date.now(),
    question: sample.question.length > SHADOW_QUESTION_LIMIT
      ? `${sample.question.slice(0, SHADOW_QUESTION_LIMIT)}…`
      : sample.question,
  }
}

export function shadowLogPath(): string {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(dshHome, 'storages', 'advisor-group', 'classifier-shadow.jsonl')
}

let writeChain: Promise<void> = Promise.resolve()

/** Append one shadow sample (serialized; failures degrade to a silent no-op). */
export function appendShadowSample(sample: ShadowSample): void {
  const line = `${JSON.stringify(formatShadowSample(sample))}\n`
  writeChain = writeChain
    .then(async () => {
      const path = shadowLogPath()
      await fsp.mkdir(dirname(path), { recursive: true })
      await fsp.appendFile(path, line, 'utf8')
    })
    .catch((error) => {
      console.warn(
        '[dsh-advisor-group] 分类器影子样本写入失败：',
        error instanceof Error ? error.message : String(error),
      )
    })
}

export interface ShadowSummary {
  total: number
  escalated: number
  launched: number
  avgConfidence?: number
  samples: ShadowSample[]
}

/** Read the most recent `limit` samples plus lightweight statistics. */
export async function readShadowSamples(limit = 200): Promise<ShadowSummary> {
  let raw = ''
  try {
    raw = await fsp.readFile(shadowLogPath(), 'utf8')
  } catch {
    return { total: 0, escalated: 0, launched: 0, samples: [] }
  }
  const all: ShadowSample[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as Partial<ShadowSample>
      if (typeof parsed.ts !== 'number' || typeof parsed.question !== 'string') continue
      all.push(formatShadowSample(parsed as ShadowSample))
    } catch {
      // Skip malformed lines.
    }
  }
  const tail = all.slice(-Math.max(1, Math.min(limit, 500)))
  const withConfidence = all.filter((s) => typeof s.confidence === 'number')
  return {
    total: all.length,
    escalated: all.filter((s) => s.shouldEscalate).length,
    launched: all.filter((s) => s.launched).length,
    ...(withConfidence.length > 0
      ? {
          avgConfidence:
            withConfidence.reduce((sum, s) => sum + (s.confidence ?? 0), 0) / withConfidence.length,
        }
      : {}),
    samples: tail,
  }
}
