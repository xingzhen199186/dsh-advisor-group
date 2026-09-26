import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

/**
 * A5.1 — followUp conflict guard: ask_advisors with sessionId+followUp must be
 * refused while that session's run is still in flight (previously it appended
 * a message and started a SECOND run over the same session). The in-flight
 * state is `activeAborts` (registered at run entry, removed in `finally`), so
 * the same registration also makes the run visible to stop and resume.
 */

// See tools-schema.test.ts: the real @deepseek-ai/dsh-tools pulls a host
// peer that is not installed in this repo; pass defineTool options through.
vi.mock('@deepseek-ai/dsh-tools', () => ({
  defineTool: (options: unknown) => options,
}))

import { registerAdvisorTools } from '../src/tools'
import { AdvisorGroupService } from '../src/service'
import type { AdvisorConfig, Config } from '../src/config'

const ADVISOR: AdvisorConfig = {
  id: 'a1',
  name: '顾问A',
  provider: 'fake-provider',
  model: 'fake-model',
  systemPrompt: '你是专家。',
}

const CONFIG: Config = {
  enabled: true,
  discussion: {
    maxRounds: 2,
    maxAdvisorsPerCall: 3,
    parallel: true,
    autoDeepen: true,
    stopOnConsensus: false,
    // Long enough that only the explicit stop below can abort the hang.
    advisorTimeoutMs: 10_000,
  },
  trigger: {
    requireClassifier: true,
    allowWebFallback: true,
    confidenceThreshold: 0.6,
  },
  ui: {
    theme: 'retro-green',
    showTimestamps: true,
    autoExpand: true,
  },
  quota: {
    enabled: false,
    maxPerDay: 50,
  },
  advisors: [ADVISOR],
}

function makeService(): { service: AdvisorGroupService; hangArmed: Promise<void> } {
  let hanging = true
  let armHang: (() => void) | undefined
  const hangArmed = new Promise<void>((resolve) => {
    armHang = resolve
  })
  const fakeCtx = {
    on: () => {},
    emit: () => {},
    llm: {
      listProviders: () => [{ id: 'fake-provider' }],
      async *stream(options: { signal?: AbortSignal }) {
        // First call hangs until the run's combined signal aborts it; later
        // calls answer normally so the post-stop follow-up can finish.
        if (hanging) {
          hanging = false
          yield { type: 'reasoning-delta', text: '思考中' } as never
          await new Promise<never>((_resolve, reject) => {
            options.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            )
            // The abort listener must be attached BEFORE the test stops the
            // run: addEventListener never fires on an already-aborted signal,
            // so stopping too early would hang the stream forever.
            armHang?.()
          })
          return
        }
        yield { type: 'text-delta', text: '顾问的回答' } as never
      },
    },
  } as unknown as Context
  return { service: new AdvisorGroupService(fakeCtx, CONFIG), hangArmed }
}

describe('followUp while the session is running (A5.1 guard)', () => {
  it('rejects the in-flight follow-up, exposes the run to stop/resume, accepts once idle', async () => {
    const { service, hangArmed } = makeService()
    const ask = registerAdvisorTools(service).find((tool) => tool.name === 'ask_advisors')
    expect(ask).toBeDefined()
    const exec = { agent: undefined, signal: undefined } as never

    const session = service.createSession('测试问题', undefined, [], 'C:\\work')
    const run = service.runOneRoundAndSummarize(session)
    // Registration happens synchronously at run entry, before any await.
    expect(service.isSessionRunning(session.id)).toBe(true)

    type AskResult = { sessionId: string; advice: string; skipped?: boolean; reason?: string }
    const blocked = (await ask!.execute({ sessionId: session.id, followUp: '再追问一次' }, exec)) as AskResult
    expect(blocked).toMatchObject({ skipped: true, reason: 'session-running' })
    expect(blocked.advice).toContain('运行中')

    // The same registration is what stop and resume consult: both must see it.
    expect(service.resumeConsultation(session.id)).toEqual({ ok: false, reason: expect.stringContaining('运行中') })
    await hangArmed
    expect(service.stopConsultation(session.id)).toBe(true)

    const stopped = await run
    expect(stopped.stopped).toBe(true)
    expect(service.getSession(session.id)?.status).toBe('cancelled')
    expect(service.isSessionRunning(session.id)).toBe(false)

    // Idle: the identical follow-up now runs through (advisor answers this time).
    const allowed = (await ask!.execute({ sessionId: session.id, followUp: '再追问一次' }, exec)) as AskResult
    expect(allowed).toMatchObject({ skipped: false })
    expect(allowed.advice).toContain('再追问一次')
    expect(allowed.advice).toContain('顾问的回答')
  })
})
