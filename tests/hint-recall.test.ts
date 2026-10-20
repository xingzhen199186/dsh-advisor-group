import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// src/index.ts pulls src/tools.ts, which imports the real @deepseek-ai/dsh-tools;
// its host peer (dsh-sandbox) is not installed here. Pass options through.
vi.mock('@deepseek-ai/dsh-tools', () => ({
  defineTool: (options: unknown) => options,
}))

import { recallHintCandidates } from '../src/index'
import { askStoreRoot, logJevDecision, registeredSessionIds } from '../src/cross-session'
import { crossSessionHintForTurn } from '../src/session-router'
import type { RosterSource } from '../src/session-roster'

function row(id: string, title: string, extra: Partial<RosterSource> = {}): RosterSource {
  return {
    sessionId: id,
    updatedAt: 1_700_000_000_000,
    running: false,
    cwd: 'I:\\proj',
    projections: { values: { title } },
    ...extra,
  }
}

/** Parsed `routing-jev.log` lines (diagnostics only). */
interface LogLine {
  decision?: string
  called?: boolean
}

function readLogLines(): LogLine[] {
  try {
    return readFileSync(join(askStoreRoot(), 'routing-jev.log'), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as LogLine)
  } catch {
    return []
  }
}

describe('background hint recall', () => {
  let home: string
  let savedHome: string | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'advisor-group-hint-recall-'))
    savedHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
  })

  afterEach(() => {
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    rmSync(home, { recursive: true, force: true })
  })

  it('drops sessions no workspace registers from the hint recall', () => {
    const sessions = [row('unregistered', 'jev浏览器'), row('live', 'jev浏览器')]
    const candidates = recallHintCandidates({
      sessions,
      registered: new Set(['live']),
      text: 'jev浏览器 的进度',
      topN: 8,
      currentSessionId: 'self',
    })
    expect(candidates.map((candidate) => candidate.sessionId)).toEqual(['live'])
  })

  it('produces no hint and logs one skipped line when nothing is registered', async () => {
    const sessions = [row('a', 'jev浏览器'), row('b', 'jev浏览器')]
    const candidates = recallHintCandidates({
      sessions,
      registered: new Set(),
      text: 'jev浏览器 的进度',
      topN: 8,
      currentSessionId: 'self',
    })
    expect(candidates).toEqual([])
    let judged = false
    const hint = await crossSessionHintForTurn({
      text: 'jev浏览器 的进度',
      mode: 'always',
      candidates,
      judge: async () => {
        judged = true
        return { askConfidence: 0.9, pick: 'a', sensitiveConfidence: 0.1 }
      },
      log: logJevDecision,
    })
    expect(hint).toBeUndefined()
    expect(judged).toBe(false)
    expect(readLogLines()).toEqual([
      expect.objectContaining({ kind: 'ask', decision: 'skipped', called: false }),
    ])
  })

  it('never names an unregistered session in the hint', async () => {
    const sessions = [row('unregistered', 'jev浏览器'), row('live', '另一个浏览器')]
    const candidates = recallHintCandidates({
      sessions,
      registered: new Set(['live']),
      text: '浏览器 的进度',
      topN: 8,
      currentSessionId: 'self',
    })
    expect(candidates.map((candidate) => candidate.sessionId)).toEqual(['live'])
    // A Jev pick naming the unregistered id cannot resolve against the filtered
    // list, so no hint is produced.
    const rejected = await crossSessionHintForTurn({
      text: '浏览器 的进度',
      mode: 'always',
      candidates,
      judge: async () => ({ askConfidence: 0.9, pick: 'unregistered', sensitiveConfidence: 0.1 }),
    })
    expect(rejected).toBeUndefined()
    const accepted = await crossSessionHintForTurn({
      text: '浏览器 的进度',
      mode: 'always',
      candidates,
      judge: async () => ({ askConfidence: 0.9, pick: 'live', sensitiveConfidence: 0.1 }),
    })
    expect(accepted).toBe('「这件事可能更适合问：另一个浏览器（ask_session）」')
  })

  it('does not filter when the host has no workspace registry', () => {
    const sessions = [row('a', 'jev浏览器'), row('b', 'jev浏览器')]
    expect(registeredSessionIds({})).toBeUndefined()
    const candidates = recallHintCandidates({
      sessions,
      registered: registeredSessionIds({}),
      text: 'jev浏览器 的进度',
      topN: 8,
      currentSessionId: 'self',
    })
    expect(candidates.map((candidate) => candidate.sessionId).sort()).toEqual(['a', 'b'])
  })
})
