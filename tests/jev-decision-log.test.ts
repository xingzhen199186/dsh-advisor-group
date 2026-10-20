import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { askStoreRoot, logJevDecision } from '../src/cross-session'
import {
  crossSessionHintForTurn,
  routeSessionsWithEngine,
  type RouteCandidate,
} from '../src/session-router'
import type { RosterSource } from '../src/session-roster'

/** One parsed line of `routing-jev.log`. */
interface LogLine {
  at: string
  kind: string
  question: string
  called: boolean
  configured: boolean
  decision: string
  pickedId?: string
  pickedTitle?: string
  confidence?: number
  candidates?: Array<{ id: string; title: string }>
  error?: string
}

function logPath(): string {
  return join(askStoreRoot(), 'routing-jev.log')
}

function readLines(): LogLine[] {
  try {
    return readFileSync(logPath(), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as LogLine)
  } catch {
    return []
  }
}

function row(id: string, title: string): RosterSource {
  return { sessionId: id, updatedAt: 1_700_000_000_000, running: false, projections: { values: { title } } }
}

const candidates: RouteCandidate[] = [
  { sessionId: 'session-a', name: '极简遥控器新', score: 90, reason: '标题命中 · 温' },
  { sessionId: 'session-b', name: '顾问群插件', score: 80, reason: '目录命中 · 冷' },
]

const ASK_QUESTION = '那个会话的进度如何？'
const SELF_STOPPED = '帮我把这句话改得通顺一点'

describe('Jev decision log', () => {
  let home: string
  let savedHome: string | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'advisor-group-jev-log-'))
    savedHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
  })

  afterEach(() => {
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    rmSync(home, { recursive: true, force: true })
  })

  describe('logJevDecision', () => {
    it('writes one JSON line with the expected decision', () => {
      logJevDecision({
        kind: 'route',
        at: '2026-10-20T00:00:00.000Z',
        question: '那个会话的进度如何？',
        called: true,
        configured: true,
        decision: 'recommend',
        pickedId: 'session-a',
        pickedTitle: '极简遥控器新',
        confidence: 0.9,
        candidates: [{ id: 'session-a', title: '极简遥控器新' }],
      })
      const lines = readLines()
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatchObject({
        at: '2026-10-20T00:00:00.000Z',
        kind: 'route',
        question: '那个会话的进度如何？',
        called: true,
        configured: true,
        decision: 'recommend',
        pickedId: 'session-a',
        pickedTitle: '极简遥控器新',
        confidence: 0.9,
        candidates: [{ id: 'session-a', title: '极简遥控器新' }],
      })
    })

    it('truncates the question to 300 chars and each title to 80', () => {
      logJevDecision({
        kind: 'ask',
        question: '问'.repeat(400),
        called: false,
        configured: false,
        decision: 'skipped',
        candidates: [{ id: 'session-x', title: '题'.repeat(200) }],
      })
      const line = readLines()[0]
      expect(line.question).toHaveLength(300)
      expect(line.candidates?.[0]?.title).toHaveLength(80)
    })

    it('appends one line per call', () => {
      logJevDecision({ kind: 'route', question: '第一个问题', called: false, configured: true, decision: 'skipped' })
      logJevDecision({ kind: 'route', question: '第二个问题', called: true, configured: true, decision: 'keep', confidence: 0.6 })
      const lines = readLines()
      expect(lines).toHaveLength(2)
      expect(lines.map((line) => line.decision)).toEqual(['skipped', 'keep'])
      expect(lines.map((line) => line.question)).toEqual(['第一个问题', '第二个问题'])
    })

    it('never throws when the log directory cannot be created', () => {
      // A regular file where the store directory should be makes mkdir fail.
      const store = join(home, 'storages', 'advisor-group')
      mkdirSync(join(home, 'storages'), { recursive: true })
      writeFileSync(store, 'not a directory', 'utf8')
      expect(() =>
        logJevDecision({
          kind: 'route',
          question: 'x',
          called: true,
          configured: true,
          decision: 'error',
          error: 'boom',
        }),
      ).not.toThrow()
    })
  })

  describe('routing engine attempts', () => {
    const sessions = [row('a', 'alpha beta'), row('b', 'alpha beta')]

    it('writes nothing for a pure local pass', async () => {
      await routeSessionsWithEngine(sessions, 'alpha beta', {
        engine: 'local',
        cache: false,
        log: logJevDecision,
        jev: async () => ({ choice: 'b', confidence: 0.9 }),
      })
      expect(readLines()).toHaveLength(0)
    })

    it('records recommend when a confident pick moves', async () => {
      const result = await routeSessionsWithEngine(sessions, 'alpha beta', {
        engine: 'jev',
        topN: 8,
        cache: false,
        log: logJevDecision,
        jev: async () => ({ choice: 'b', confidence: 0.9 }),
      })
      expect(result[0]?.sessionId).toBe('b')
      const [line] = readLines()
      expect(line).toMatchObject({
        kind: 'route',
        called: true,
        configured: true,
        decision: 'recommend',
        pickedId: 'b',
        pickedTitle: 'alpha beta',
        confidence: 0.9,
      })
    })

    it('records keep for the 0.45–0.75 band', async () => {
      const result = await routeSessionsWithEngine(sessions, 'alpha beta', {
        engine: 'jev',
        topN: 8,
        cache: false,
        log: logJevDecision,
        jev: async () => ({ choice: 'b', confidence: 0.6 }),
      })
      expect(result[0]?.sessionId).toBe('a')
      const [line] = readLines()
      expect(line).toMatchObject({ decision: 'keep', pickedId: 'b', confidence: 0.6 })
    })

    it('records none below 0.45 and for the "none" escape', async () => {
      await routeSessionsWithEngine(sessions, 'alpha beta', {
        engine: 'jev',
        topN: 8,
        cache: false,
        log: logJevDecision,
        jev: async () => ({ choice: 'b', confidence: 0.3 }),
      })
      await routeSessionsWithEngine(sessions, 'alpha beta', {
        engine: 'jev',
        topN: 8,
        cache: false,
        log: logJevDecision,
        jev: async () => ({ choice: 'none', confidence: 0.9 }),
      })
      expect(readLines().map((line) => line.decision)).toEqual(['none', 'none'])
    })

    it('records error with the message', async () => {
      await routeSessionsWithEngine(sessions, 'alpha beta', {
        engine: 'jev',
        topN: 8,
        cache: false,
        log: logJevDecision,
        jev: async () => {
          throw new Error('Jev 超时（1000ms）')
        },
      })
      const [line] = readLines()
      expect(line).toMatchObject({
        decision: 'error',
        called: true,
        configured: true,
        error: 'Jev 超时（1000ms）',
      })
    })

    it('records skipped when the caller chose jev but it is not configured', async () => {
      await routeSessionsWithEngine(sessions, 'alpha beta', {
        engine: 'jev',
        topN: 8,
        cache: false,
        log: logJevDecision,
      })
      const [line] = readLines()
      expect(line).toMatchObject({ kind: 'route', decision: 'skipped', called: false, configured: false })
    })
  })

  describe('ask judgment attempts', () => {
    it('records skipped when the gated prefilter stops the turn', async () => {
      const hint = await crossSessionHintForTurn({
        text: SELF_STOPPED,
        mode: 'gated',
        candidates,
        log: logJevDecision,
        judge: async () => ({ askConfidence: 0.9, pick: 'session-a', sensitiveConfidence: 0.1 }),
      })
      expect(hint).toBeUndefined()
      const [line] = readLines()
      expect(line).toMatchObject({ kind: 'ask', decision: 'skipped', called: false, configured: true })
    })

    it('records recommend with the confidence and the picked title', async () => {
      const hint = await crossSessionHintForTurn({
        text: ASK_QUESTION,
        mode: 'gated',
        candidates,
        log: logJevDecision,
        judge: async () => ({ askConfidence: 0.8, pick: 'session-a', sensitiveConfidence: 0.1 }),
      })
      expect(hint).toContain('极简遥控器新')
      const [line] = readLines()
      expect(line).toMatchObject({
        kind: 'ask',
        decision: 'recommend',
        called: true,
        configured: true,
        pickedId: 'session-a',
        pickedTitle: '极简遥控器新',
        confidence: 0.8,
      })
    })

    it('records none for a low-confidence or sensitive answer', async () => {
      await crossSessionHintForTurn({
        text: ASK_QUESTION,
        mode: 'always',
        candidates,
        log: logJevDecision,
        judge: async () => ({ askConfidence: 0.4, pick: 'session-a', sensitiveConfidence: 0.1 }),
      })
      await crossSessionHintForTurn({
        text: ASK_QUESTION,
        mode: 'always',
        candidates,
        log: logJevDecision,
        judge: async () => ({ askConfidence: 0.9, pick: 'session-a', sensitiveConfidence: 0.9 }),
      })
      expect(readLines().map((line) => line.decision)).toEqual(['none', 'none'])
    })

    it('records error with the message', async () => {
      const hint = await crossSessionHintForTurn({
        text: ASK_QUESTION,
        mode: 'always',
        candidates,
        log: logJevDecision,
        judge: async () => {
          throw new Error('Jev HTTP 500')
        },
      })
      expect(hint).toBeUndefined()
      const [line] = readLines()
      expect(line).toMatchObject({ decision: 'error', called: true, configured: true, error: 'Jev HTTP 500' })
    })
  })
})
