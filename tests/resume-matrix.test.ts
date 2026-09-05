import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { AdvisorGroupService } from '../src/service'
import type { AdvisorConfig, Config } from '../src/config'

/**
 * Boundary matrix (advisor audit item 3): stops in awkward places must resume
 * WITHOUT losing or duplicating the driver deep-question.
 *  - stop BETWEEN rounds (question already pushed) → resume must NOT re-ask it;
 *  - stop DURING driver deep-question generation (nothing pushed) → resume must
 *    generate exactly one follow-up.
 */

const ADVISOR_A: AdvisorConfig = { id: 'a1', name: '顾问A', provider: 'fake-provider', model: 'fake-model', systemPrompt: '你是A专家。' }
const ADVISOR_B: AdvisorConfig = { id: 'b1', name: '顾问B', provider: 'fake-provider', model: 'fake-model', systemPrompt: '你是B专家。' }

const CONFIG: Config = {
  enabled: true,
  discussion: {
    maxRounds: 2,
    maxAdvisorsPerCall: 2,
    parallel: true,
    autoDeepen: true,
    stopOnConsensus: false,
    advisorTimeoutMs: 60000,
    // The driver must ACTUALLY generate (stream), so the call order is
    // deterministic: 1 A r1, 2 B r1, 3 driver(r2), 4 A' r2, 5 B' r2, 6 driver(conclusion).
    driverModel: { provider: 'fake-provider', model: 'fake-model' },
  },
  trigger: { requireClassifier: true, allowWebFallback: true, confidenceThreshold: 0.6 },
  ui: { theme: 'retro-green', showTimestamps: true, autoExpand: true },
  quota: { enabled: false, maxPerDay: 50 },
  advisors: [ADVISOR_A, ADVISOR_B],
}

function hangUntil(signal?: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
  })
}

/** Call-ordered stub: driver calls (non-专家 system) and advisor calls with optional hang points. */
function matrixStub(options: { hangAdvisorAtCall?: number; hangDriverAtCall?: number }): { ctx: Context; calls: () => number } {
  let call = 0
  const ctx = {
    on: () => {},
    emit: () => {},
    llm: {
      listProviders: () => [{ id: 'fake-provider' }],
      async *stream(opts: { signal?: AbortSignal; system?: string }) {
        call += 1
        const system = String((opts as { system?: string }).system ?? '')
        const isDriver = !system.includes('专家')
        if (isDriver) {
          if (options.hangDriverAtCall === call) {
            await hangUntil(opts.signal)
            return
          }
          yield { type: 'reasoning-delta', text: '驱动想' } as never
          yield { type: 'text-delta', text: '追问测试内容' } as never
          return
        }
        if (options.hangAdvisorAtCall === call) {
          await hangUntil(opts.signal)
          return
        }
        yield { type: 'reasoning-delta', text: '想' } as never
        yield { type: 'text-delta', text: system.includes('B专家') ? 'B 答' : 'A 答' } as never
      },
    },
  } as unknown as Context
  return { ctx, calls: () => call }
}

function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      if (condition()) resolve()
      else if (Date.now() - started > timeoutMs) reject(new Error('waitFor timeout'))
      else setTimeout(tick, 20)
    }
    tick()
  })
}

const questionCount = (session: { messages: Array<{ role: string; content: string }> }) =>
  session.messages.filter((m) => m.role === 'main' && m.content.includes('追问')).length

describe('boundary matrix: deep-question preservation', () => {
  it('stop BETWEEN rounds: resume does NOT ask the follow-up twice', async () => {
    const { ctx, calls } = matrixStub({ hangAdvisorAtCall: 4 }) // A of round 2
    const service = new AdvisorGroupService(ctx, CONFIG)
    const session = service.createSession('问题', undefined, [], 'C:\\work')
    const pipeline = service.runAutoPipeline(session, undefined, undefined)
    // Calls: 1 A r1, 2 B r1, 3 driver(r2 follow-up pushed), 4 A' r2 (hangs).
    await waitFor(() => calls() >= 4)
    expect(service.stopConsultation(session.id)).toBe(true)
    await pipeline
    expect(session.status).toBe('cancelled')
    // The follow-up was already pushed before round 2 started.
    expect(questionCount(session)).toBe(1)

    expect(service.resumeConsultation(session.id)).toEqual({ ok: true })
    await waitFor(() => service.getSession(session.id)?.status === 'completed')
    // Exactly ONE deep-question in the whole consultation.
    expect(questionCount(session)).toBe(1)
    const advisorMessages = session.messages.filter((m) => m.role === 'advisor')
    expect(advisorMessages).toHaveLength(4)
    expect(advisorMessages.filter((m) => m.round === 2)).toHaveLength(2)
  })

  it('stop DURING follow-up generation: resume generates exactly one follow-up', async () => {
    const { ctx, calls } = matrixStub({ hangDriverAtCall: 3 }) // driver generating r2 question
    const service = new AdvisorGroupService(ctx, CONFIG)
    const session = service.createSession('问题', undefined, [], 'C:\\work')
    const pipeline = service.runAutoPipeline(session, undefined, undefined)
    await waitFor(() => calls() >= 3)
    expect(service.stopConsultation(session.id)).toBe(true)
    await pipeline
    expect(session.status).toBe('cancelled')
    // Nothing was pushed while the driver was still generating.
    expect(questionCount(session)).toBe(0)

    expect(service.resumeConsultation(session.id)).toEqual({ ok: true })
    await waitFor(() => service.getSession(session.id)?.status === 'completed')
    expect(questionCount(session)).toBe(1)
    const advisorMessages = session.messages.filter((m) => m.role === 'advisor')
    expect(advisorMessages).toHaveLength(4)
  })
})
