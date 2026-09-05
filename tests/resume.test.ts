import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { AdvisorGroupService } from '../src/service'
import type { AdvisorConfig, Config } from '../src/config'

/**
 * Stop → resume (继续聊天): a stopped pipeline must resume from its
 * interruption point — a partially-answered round completes with ONLY the
 * missing advisors, remaining rounds run, and the pipeline closes normally.
 * Cross-restart recovery is covered by the durable snapshot round-trip.
 */

const ADVISOR_A: AdvisorConfig = {
  id: 'a1',
  name: '顾问A',
  provider: 'fake-provider',
  model: 'fake-model',
  systemPrompt: '你是A专家。',
}

const ADVISOR_B: AdvisorConfig = {
  id: 'b1',
  name: '顾问B',
  provider: 'fake-provider',
  model: 'fake-model',
  systemPrompt: '你是B专家。',
}

function config(overrides: Partial<Config> = {}): Config {
  return {
    enabled: true,
    discussion: {
      maxRounds: 2,
      maxAdvisorsPerCall: 2,
      parallel: true,
      autoDeepen: true,
      stopOnConsensus: false,
      advisorTimeoutMs: 60000,
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
    advisors: [ADVISOR_A, ADVISOR_B],
    ...overrides,
  }
}

function waitFor(condition: () => boolean, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      if (condition()) {
        resolve()
      } else if (Date.now() - started > timeoutMs) {
        reject(new Error('waitFor timeout'))
      } else {
        setTimeout(tick, 25)
      }
    }
    tick()
  })
}

/** Stream stub keyed by advisor identity (via the assembled system prompt):
 *  A answers fast; FIRST B call hangs (mid-stream stop), later B calls fast. */
function streamStub(): Context {
  let bHangs = true
  return {
    on: () => {},
    emit: () => {},
    llm: {
      listProviders: () => [{ id: 'fake-provider' }],
      async *stream(options: { signal?: AbortSignal; system?: string }) {
        const system = String((options as { system?: string }).system ?? '')
        if (system.includes('你是B专家')) {
          yield { type: 'reasoning-delta', text: 'B 想' } as never
          if (bHangs) {
            bHangs = false
            await new Promise<never>((_resolve, reject) => {
              options.signal?.addEventListener('abort', () =>
                reject(new DOMException('Aborted', 'AbortError')),
              )
            })
          }
          yield { type: 'text-delta', text: 'B 答' } as never
          return
        }
        if (system.includes('你是A专家')) {
          yield { type: 'reasoning-delta', text: 'A 想' } as never
          yield { type: 'text-delta', text: 'A 答' } as never
          return
        }
        yield { type: 'reasoning-delta', text: '驱动想' } as never
        yield { type: 'text-delta', text: '驱动答' } as never
      },
    },
  } as unknown as Context
}

describe('stop → resume (继续聊天)', () => {
  it('completes the interrupted round with only the missing advisor, then closes normally', async () => {
    const service = new AdvisorGroupService(streamStub(), config({ discussion: { ...config().discussion, maxRounds: 1 } }))
    const session = service.createSession('测试问题', undefined, [], 'C:\\work')
    expect(session.status).toBe('active')

    const pipeline = service.runAutoPipeline(session, undefined, undefined)
    // A answered; B is now hanging mid-stream.
    await waitFor(() => (session.messages.filter((m) => m.role === 'advisor').length ?? 0) === 1)
    expect(service.stopConsultation(session.id)).toBe(true)
    const stoppedSummary = await pipeline
    expect(stoppedSummary.stopped).toBe(true)
    expect(session.status).toBe('cancelled')
    // The stop reason must be recorded (user stop vs host/stream abort) so a
    // future auto-retry NEVER retries a user-initiated stop.
    expect(session.stopReason).toBe('user-stop')

    // Resume: B must answer (A must NOT be re-asked), then close completed.
    const resumed = service.resumeConsultation(session.id)
    expect(resumed).toEqual({ ok: true })
    await waitFor(() => service.getSession(session.id)?.status === 'completed')
    // A completed resume clears the stop reason.
    expect(service.getSession(session.id)?.stopReason).toBeUndefined()

    const advisorMessages = session.messages.filter((m) => m.role === 'advisor')
    expect(advisorMessages).toHaveLength(2)
    expect(advisorMessages[0].advisorId).toBe('a1')
    expect(advisorMessages[0].content).toBe('A 答')
    expect(advisorMessages[1].advisorId).toBe('b1')
    expect(advisorMessages[1].content).toBe('B 答')
    expect(advisorMessages[1].round).toBe(1)
    // Only one main question in round 1 (no re-asked A, no dangling follow-up).
    const mainMessages = session.messages.filter((m) => m.role === 'main')
    expect(mainMessages).toHaveLength(1)
  })

  it('rejects resume while running and after completion', async () => {
    const service = new AdvisorGroupService(streamStub(), config({ discussion: { ...config().discussion, maxRounds: 1 } }))
    const session = service.createSession('测试问题', undefined, [], 'C:\\work')
    const pipeline = service.runAutoPipeline(session, undefined, undefined)
    await waitFor(() => (session.messages.filter((m) => m.role === 'advisor').length ?? 0) === 1)
    expect(service.resumeConsultation(session.id).ok).toBe(false) // running
    service.stopConsultation(session.id)
    await pipeline
    await service.resumeConsultation(session.id)
    await waitFor(() => service.getSession(session.id)?.status === 'completed')
    expect(service.resumeConsultation(session.id)).toEqual({ ok: false, reason: expect.stringContaining('无需继续') })
  })

  it('restores an interrupted session from the durable snapshot after a restart', async () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'advisor-group-resume-'))
    const saved = process.env.DSH_HOME
    process.env.DSH_HOME = dshHome
    try {
      const cfg = config({ advisors: [ADVISOR_A], discussion: { ...config().discussion, maxRounds: 1, maxAdvisorsPerCall: 1 } })
      const serviceA = new AdvisorGroupService(streamStub(), cfg)
      const session = serviceA.createSession(
        '快照问题',
        undefined,
        [],
        'C:\\work',
        'session-00000000-0000-4000-8000-000000000001',
      )
      // Wait for the snapshot file to land.
      const snapshotPath = join(dshHome, 'storages', 'advisor-group', 'sessions', `${session.id}.json`)
      await waitFor(() => existsSync(snapshotPath))

      // "Restart": a brand-new service instance over the same home.
      const serviceB = new AdvisorGroupService(streamStub(), cfg)
      const restored = serviceB.getSession(session.id)
      expect(restored).toBeDefined()
      expect(restored?.status).toBe('cancelled')
      expect(restored?.messages.some((m) => m.role === 'main')).toBe(true)
      expect(restored?.cwd).toBe('C:\\work')
      // The DSH session id survives the snapshot round-trip so resume rebuilds
      // the AGENT session (card data source), not a detached consult session.
      expect(restored?.dshSessionId).toBe('session-00000000-0000-4000-8000-000000000001')
      expect(serviceB.resumeConsultation(session.id)).toEqual({ ok: true })
      await waitFor(() => serviceB.getSession(session.id)?.status === 'completed')
      const advisorMessages = restored?.messages.filter((m) => m.role === 'advisor') ?? []
      expect(advisorMessages.length).toBe(1)
      expect(advisorMessages[0].content).toBe('A 答')
    } finally {
      if (saved === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = saved
      rmSync(dshHome, { recursive: true, force: true })
    }
  })
})
