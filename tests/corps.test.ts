import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CORPS_NAME_MAX,
  findCorpsSession,
  loadCorpsCards,
  saveCorpsCards,
  upsertCorpsCard,
  type CorpsCards,
} from '../src/corps'

const root = mkdtempSync(join(tmpdir(), 'dsh-corps-'))
let seq = 0
function file(): string {
  seq += 1
  return join(root, `corps-${seq}.json`)
}

describe('advisor corps store', () => {
  it('round-trips cards through an atomic file', () => {
    const target = file()
    const cards: CorpsCards = {
      'session-a': { name: '老王', duty: '架构评审', updatedAt: 1 },
    }
    saveCorpsCards(cards, target)
    expect(loadCorpsCards(target)).toEqual(cards)
    expect(JSON.parse(readFileSync(target, 'utf8')).version).toBe(1)
  })

  it('degrades a missing or damaged file to an empty map', () => {
    expect(loadCorpsCards(join(root, 'missing.json'))).toEqual({})
    const damaged = file()
    writeFileSync(damaged, '{not json', 'utf8')
    expect(loadCorpsCards(damaged)).toEqual({})
  })

  it('drops malformed entries but keeps the valid ones', () => {
    const target = file()
    writeFileSync(
      target,
      JSON.stringify({
        version: 1,
        cards: {
          good: { name: ' 老李 ', duty: ' 财务 ', updatedAt: 2 },
          emptyName: { name: '   ', duty: 'x' },
          noDuty: { name: '甲' },
          bad: 'nope',
        },
      }),
      'utf8',
    )
    expect(loadCorpsCards(target)).toEqual({
      good: { name: '老李', duty: '财务', updatedAt: 2 },
      noDuty: { name: '甲', duty: '', updatedAt: expect.any(Number) },
    })
  })
})

describe('upsertCorpsCard', () => {
  it('creates, updates and deletes one card', () => {
    const created = upsertCorpsCard({}, 's1', ' 老王 ', ' 架构 ', 10)
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.cards.s1).toEqual({ name: '老王', duty: '架构', updatedAt: 10 })

    const updated = upsertCorpsCard(created.cards, 's1', '老王', '架构与评审', 20)
    expect(updated.ok).toBe(true)
    if (!updated.ok) return
    expect(updated.cards.s1).toEqual({ name: '老王', duty: '架构与评审', updatedAt: 20 })

    const deleted = upsertCorpsCard(updated.cards, 's1', '', '', 30)
    expect(deleted.ok).toBe(true)
    if (!deleted.ok) return
    expect(deleted.cards.s1).toBeUndefined()
  })

  it('rejects a name another session already owns (case-insensitive)', () => {
    const first = upsertCorpsCard({}, 's1', 'Alice', '', 1)
    if (!first.ok) throw new Error('setup failed')
    const clash = upsertCorpsCard(first.cards, 's2', 'alice', '', 2)
    expect(clash.ok).toBe(false)
    if (clash.ok) return
    expect(clash.code).toBe('duplicate-name')
  })

  it('rejects invalid ids, oversized names and duties', () => {
    expect(upsertCorpsCard({}, '', '甲', '').ok).toBe(false)
    expect(upsertCorpsCard({}, 's1', 'x'.repeat(CORPS_NAME_MAX + 1), '').ok).toBe(false)
    expect(upsertCorpsCard({}, 's1', '甲', 'x'.repeat(201)).ok).toBe(false)
  })
})

describe('findCorpsSession', () => {
  const cards: CorpsCards = {
    s1: { name: '老王', duty: '架构', updatedAt: 1 },
    s2: { name: 'Alice', duty: '财务', updatedAt: 2 },
  }

  it('matches an exact name case-insensitively and trims the input', () => {
    expect(findCorpsSession(cards, '老王')).toBe('s1')
    expect(findCorpsSession(cards, '  alice ')).toBe('s2')
  })

  it('never guesses on a partial name or an empty target', () => {
    expect(findCorpsSession(cards, '老')).toBeUndefined()
    expect(findCorpsSession(cards, '   ')).toBeUndefined()
  })

  it('returns nothing when a hand-edited file holds duplicate names', () => {
    const duplicate: CorpsCards = {
      s1: { name: '同名', duty: '', updatedAt: 1 },
      s2: { name: '同名', duty: '', updatedAt: 2 },
    }
    expect(findCorpsSession(duplicate, '同名')).toBeUndefined()
  })
})

// Keep the temp directory from growing across the whole suite.
process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // Best effort.
  }
})
