import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { AdvisorGroupService } from '../src/service'
import type { AdvisorConfig, Config } from '../src/config'

/**
 * Cross-instance resume lock: two dsh processes sharing DSH_HOME must not run
 * the same resume concurrently. mkdir is atomic on local filesystems; a lock
 * left behind by a crashed holder is taken over after 10 minutes.
 */

const ADVISOR_A: AdvisorConfig = {
  id: 'a1',
  name: '顾问A',
  provider: 'fake-provider',
  model: 'fake-model',
  systemPrompt: '你是A专家。',
}

const CONFIG: Config = {
  enabled: true,
  discussion: { maxRounds: 2, maxAdvisorsPerCall: 2, parallel: true, autoDeepen: true, stopOnConsensus: false, advisorTimeoutMs: 60000 },
  trigger: { requireClassifier: true, allowWebFallback: true, confidenceThreshold: 0.6 },
  ui: { theme: 'retro-green', showTimestamps: true, autoExpand: true },
  quota: { enabled: false, maxPerDay: 50 },
  advisors: [ADVISOR_A],
}

function makeService(): AdvisorGroupService {
  const fakeCtx = {
    on: () => {},
    emit: () => {},
    llm: {
      listProviders: () => [{ id: 'fake-provider' }],
      async *stream(options: { signal?: AbortSignal; system?: string }) {
        const system = String((options as { system?: string }).system ?? '')
        if (system.includes('你是A专家')) {
          yield { type: 'reasoning-delta', text: 'A 想' } as never
          yield { type: 'text-delta', text: 'A 答' } as never
          return
        }
        yield { type: 'reasoning-delta', text: '想' } as never
        yield { type: 'text-delta', text: '答' } as never
      },
    },
  } as unknown as Context
  return new AdvisorGroupService(fakeCtx, CONFIG)
}

let dshHome: string
let savedHome: string | undefined

beforeEach(() => {
  dshHome = mkdtempSync(join(tmpdir(), 'advisor-group-lock-'))
  savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
})

afterEach(() => {
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
  rmSync(dshHome, { recursive: true, force: true })
})

const SESSION_ID = '00000000-0000-4000-8000-000000000000'

describe('cross-instance resume lock', () => {
  it('acquires a fresh lock and releases it', () => {
    const service = makeService()
    const svc = service as unknown as { acquireResumeLock(id: string): boolean; releaseResumeLock(id: string): void }
    const lockDir = join(dshHome, 'storages', 'advisor-group', 'sessions', `${SESSION_ID}.lock`)
    expect(svc.acquireResumeLock(SESSION_ID)).toBe(true)
    expect(existsSync(lockDir)).toBe(true)
    svc.releaseResumeLock(SESSION_ID)
    expect(existsSync(lockDir)).toBe(false)
  })

  it('refuses a second holder while the lock is fresh', () => {
    const service = makeService()
    const svc = service as unknown as { acquireResumeLock(id: string): boolean; releaseResumeLock(id: string): void }
    const lockDir = join(dshHome, 'storages', 'advisor-group', 'sessions', `${SESSION_ID}.lock`)
    mkdirSync(lockDir, { recursive: true })
    writeFileSync(join(lockDir, 'owner'), '12345', 'utf8')
    expect(svc.acquireResumeLock(SESSION_ID)).toBe(false)
    svc.releaseResumeLock(SESSION_ID)
  })

  it('takes over a stale lock (holder crashed)', () => {
    const service = makeService()
    const svc = service as unknown as { acquireResumeLock(id: string): boolean; releaseResumeLock(id: string): void }
    const lockDir = join(dshHome, 'storages', 'advisor-group', 'sessions', `${SESSION_ID}.lock`)
    mkdirSync(lockDir, { recursive: true })
    writeFileSync(join(lockDir, 'owner'), '99999', 'utf8')
    const old = new Date(Date.now() - 11 * 60_000)
    utimesSync(lockDir, old, old)
    expect(svc.acquireResumeLock(SESSION_ID)).toBe(true)
    svc.releaseResumeLock(SESSION_ID)
  })

  it('resumeConsultation refuses while another instance holds the lock', () => {
    const service = makeService()
    const session = service.createSession('问题', undefined, [], 'C:\\work')
    const lockDir = join(dshHome, 'storages', 'advisor-group', 'sessions', `${session.id}.lock`)
    mkdirSync(lockDir, { recursive: true })
    writeFileSync(join(lockDir, 'owner'), '12345', 'utf8')
    const result = service.resumeConsultation(session.id)
    expect(result.ok).toBe(false)
    expect(String(result.reason)).toContain('另一实例')
    rmSync(lockDir, { recursive: true, force: true })
  })
})
