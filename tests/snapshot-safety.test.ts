import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { AdvisorGroupService } from '../src/service'
import type { AdvisorConfig, Config } from '../src/config'

/**
 * Snapshot safety: session identities are server-minted uuids. A tampered or
 * foreign snapshot (path-injection-shaped ids, non-uuid dshSessionId) must be
 * rejected; untrusted `cwd` from a snapshot must not be used verbatim.
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
  dshHome = mkdtempSync(join(tmpdir(), 'advisor-group-safety-'))
  savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
})

afterEach(() => {
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
  rmSync(dshHome, { recursive: true, force: true })
})

describe('snapshot safety (id whitelist + untrusted cwd)', () => {
  it('rejects path-injection-shaped snapshot ids', () => {
    const dir = join(dshHome, 'storages', 'advisor-group', 'sessions')
    mkdirSync(dir, { recursive: true })
    // A malicious/foreign snapshot: id used for file path + prepare key.
    writeFileSync(
      join(dir, 'evil.json'),
      JSON.stringify({
        version: 1,
        id: '../../../somewhere/evil',
        status: 'cancelled',
        question: 'x',
        advisorIds: ['a1'],
        maxRounds: 2,
        createdAt: 0,
        updatedAt: 0,
        messages: [],
      }),
      'utf8',
    )
    // A legitimate-looking but non-uuid consult id (e.g. utf8 tricks).
    writeFileSync(
      join(dir, 'legit-check.json'),
      JSON.stringify({
        version: 1,
        id: '00000000-0000-4000-8000-000000000000',
        status: 'cancelled',
        question: 'ok',
        advisorIds: ['a1'],
        maxRounds: 2,
        createdAt: 0,
        updatedAt: 0,
        messages: [],
      }),
      'utf8',
    )
    const service = makeService()
    expect(service.getSession('../../../somewhere/evil')).toBeUndefined()
    expect(service.getSession('00000000-0000-4000-8000-000000000000')).toBeDefined()
    expect(service.getSession('evi%2f%2fl')).toBeUndefined()
  })

  it('rejects a snapshot carrying a non-uuid dshSessionId', () => {
    const dir = join(dshHome, 'storages', 'advisor-group', 'sessions')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'x.json'),
      JSON.stringify({
        version: 1,
        id: '00000000-0000-4000-8000-000000000000',
        status: 'cancelled',
        question: 'x',
        advisorIds: ['a1'],
        dshSessionId: 'session-../../etc/passwd',
        maxRounds: 2,
        createdAt: 0,
        updatedAt: 0,
        messages: [],
      }),
      'utf8',
    )
    const service = makeService()
    // Snapshot dropped entirely (dshSessionId invalid).
    expect(service.getSession('00000000-0000-4000-8000-000000000000')).toBeUndefined()
  })

  it('persists stopReason across the snapshot round-trip and clears it on resume', async () => {
    const serviceA = makeService()
    const session = serviceA.createSession('问题', undefined, [], 'C:\\work', 'session-00000000-0000-4000-8000-000000000001')
    session.status = 'cancelled'
    session.stopReason = 'user-stop'
    // Privately persist the mutated state (mirrors what runAutoPipeline does
    // on stop), then simulate a restart.
    ;(serviceA as unknown as { persistSession(s: typeof session): void }).persistSession(session)
    await new Promise((resolve) => setTimeout(resolve, 120))
    const serviceB = makeService()
    const restored = serviceB.getSession(session.id)
    expect(restored?.status).toBe('cancelled')
    expect(restored?.stopReason).toBe('user-stop')
    expect(restored?.dshSessionId).toBe('session-00000000-0000-4000-8000-000000000001')
  })

  it('persists toolSteps across the snapshot round-trip', async () => {
    const serviceA = makeService()
    const session = serviceA.createSession(
      '问题',
      undefined,
      [],
      undefined,
      'session-00000000-0000-4000-8000-000000000002',
    )
    session.messages.push({
      role: 'advisor',
      advisorId: 'a1',
      advisorName: '顾问A',
      content: '正文',
      ts: 1,
      thinkingSegments: ['想1', '想2'],
      actionDescriptions: ['我先做两步实机验证。', '然后查会话列表。'],
      toolSteps: [{ kind: 'call', name: 'read', text: '{"path":"a.txt"}', atMs: 2 }],
    })
    ;(serviceA as unknown as { persistSession(s: typeof session): void }).persistSession(session)
    await new Promise((resolve) => setTimeout(resolve, 120))
    const serviceB = makeService()
    const restored = serviceB.getSession(session.id)
    expect(restored?.messages[2]?.toolSteps).toEqual([
      { kind: 'call', name: 'read', text: '{"path":"a.txt"}', atMs: 2 },
    ])
    expect(restored?.messages[2]?.thinkingSegments).toEqual(['想1', '想2'])
    expect(restored?.messages[2]?.actionDescriptions).toEqual(['我先做两步实机验证。', '然后查会话列表。'])
  })
})
