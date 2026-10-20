import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ASK_BOOT_ID,
  askStoreDir,
  listAskRecords,
  pruneAskRecords,
  readAskRecord,
  reconcileStaleAsk,
  writeAskRecord,
  type AskRecord,
} from '../src/ask-store'

/**
 * Detached-ask store: write/read round-trip, atomic writes, path-traversal
 * rejection, tolerant reads, ordering/filters, and prune by age.
 */

const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-ask-store-'))

function freshDir(): string {
  return mkdtempSync(join(tempRoot, 'case-'))
}

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true })
})

function makeRecord(askId: string, overrides: Partial<AskRecord> = {}): AskRecord {
  return {
    askId,
    sessionId: 'session-a',
    targetSessionId: 'session-b',
    targetName: '构建会话',
    question: '这个方案可行吗？',
    state: 'waiting',
    createdAt: 1000,
    from: '2026-10-18T10:00:00.000Z',
    ...overrides,
  }
}

describe('askStoreDir', () => {
  it('appends an asks subdirectory to the base dir', () => {
    expect(askStoreDir('/tmp/advisor-group')).toBe('/tmp/advisor-group/asks')
  })
})

describe('writeAskRecord / readAskRecord', () => {
  it('round-trips every field, including the structured reply', () => {
    const dir = askStoreDir(freshDir())
    const record = makeRecord('ask-1', {
      state: 'done',
      createdAt: 111,
      settledAt: 222,
      answer: '可行。',
      reply: { conclusion: '可行', basis: '依据一', uncertainty: '低' },
      note: '备注',
      error: '无',
    })

    expect(existsSync(dir)).toBe(false)
    writeAskRecord(dir, record)

    expect(readAskRecord(dir, 'ask-1')).toEqual(record)
    expect(JSON.parse(readFileSync(join(dir, 'ask-1.json'), 'utf8'))).toEqual(record)
  })

  it('leaves no .tmp file behind after an atomic write', () => {
    const dir = askStoreDir(freshDir())
    writeAskRecord(dir, makeRecord('ask-3'))

    expect(readdirSync(dir)).toEqual(['ask-3.json'])
  })

  it('round-trips the parentAskId call-chain trace', () => {
    const dir = askStoreDir(freshDir())
    writeAskRecord(dir, makeRecord('ask-parent', { parentAskId: 'ask-inbound-1' }))

    expect(readAskRecord(dir, 'ask-parent')?.parentAskId).toBe('ask-inbound-1')
    // A record without the field stays without it (no empty-string sentinel).
    writeAskRecord(dir, makeRecord('ask-top'))
    expect(readAskRecord(dir, 'ask-top')?.parentAskId).toBeUndefined()
  })

  it('rejects an invalid askId on write and on read', () => {
    const dir = askStoreDir(freshDir())

    expect(() => writeAskRecord(dir, makeRecord('../escape'))).toThrow('invalid askId')
    expect(() => writeAskRecord(dir, makeRecord('a/b'))).toThrow('invalid askId')
    expect(existsSync(join(dir, '..', 'escape.json'))).toBe(false)
    expect(() => readAskRecord(dir, 'a/b')).toThrow('invalid askId')
  })

  it('returns undefined for a missing record', () => {
    const dir = askStoreDir(freshDir())

    expect(readAskRecord(dir, 'ask-missing')).toBeUndefined()
  })

  it('returns undefined for unparsable or malformed JSON', () => {
    const dir = askStoreDir(freshDir())
    writeAskRecord(dir, makeRecord('ask-4'))
    writeFileSync(join(dir, 'ask-broken.json'), '{ not json', 'utf8')
    writeFileSync(join(dir, 'ask-shape.json'), JSON.stringify({ askId: 'ask-shape' }), 'utf8')

    expect(readAskRecord(dir, 'ask-broken')).toBeUndefined()
    expect(readAskRecord(dir, 'ask-shape')).toBeUndefined()
  })
})

describe('listAskRecords', () => {
  it('lists newest createdAt first', () => {
    const dir = askStoreDir(freshDir())
    writeAskRecord(dir, makeRecord('ask-old', { createdAt: 100 }))
    writeAskRecord(dir, makeRecord('ask-new', { createdAt: 300 }))
    writeAskRecord(dir, makeRecord('ask-mid', { createdAt: 200 }))

    expect(listAskRecords(dir).map((record) => record.askId)).toEqual([
      'ask-new',
      'ask-mid',
      'ask-old',
    ])
  })

  it('filters by sessionId and by state, skipping unparsable files', () => {
    const dir = askStoreDir(freshDir())
    writeAskRecord(dir, makeRecord('ask-a', { sessionId: 'session-a', state: 'done', createdAt: 3 }))
    writeAskRecord(dir, makeRecord('ask-b', { sessionId: 'session-a', state: 'waiting', createdAt: 2 }))
    writeAskRecord(dir, makeRecord('ask-c', { sessionId: 'session-c', state: 'done', createdAt: 1 }))
    writeFileSync(join(dir, 'ask-broken.json'), 'not json', 'utf8')

    expect(listAskRecords(dir, { sessionId: 'session-a' }).map((record) => record.askId)).toEqual([
      'ask-a',
      'ask-b',
    ])
    expect(listAskRecords(dir, { state: 'done' }).map((record) => record.askId)).toEqual([
      'ask-a',
      'ask-c',
    ])
    expect(listAskRecords(dir, { sessionId: 'session-a', state: 'done' }).map((r) => r.askId)).toEqual([
      'ask-a',
    ])
  })

  it('returns an empty list for a missing store directory', () => {
    expect(listAskRecords(askStoreDir(freshDir()))).toEqual([])
  })
})

describe('pruneAskRecords', () => {
  it('removes records older than the window plus stray .tmp files, keeping the rest', () => {
    const dir = askStoreDir(freshDir())
    // now = 100000, window = 1000 → cutoff 99000.
    writeAskRecord(dir, makeRecord('ask-old-settled', { state: 'done', createdAt: 50000, settledAt: 60000 }))
    writeAskRecord(dir, makeRecord('ask-old-waiting', { state: 'waiting', createdAt: 40000 }))
    writeAskRecord(dir, makeRecord('ask-fresh', { state: 'done', createdAt: 99500, settledAt: 99900 }))
    writeFileSync(join(dir, 'crashed.json.tmp'), '{}', 'utf8')

    expect(pruneAskRecords(dir, 1000, 100000)).toBe(3)

    expect(readdirSync(dir)).toEqual(['ask-fresh.json'])
    expect(readAskRecord(dir, 'ask-fresh')?.askId).toBe('ask-fresh')
  })

  it('removes an unsettled record once its createdAt ages out', () => {
    const dir = askStoreDir(freshDir())
    writeAskRecord(dir, makeRecord('ask-stale', { createdAt: 1000 }))

    expect(pruneAskRecords(dir, 500, 10000)).toBe(1)
    expect(readAskRecord(dir, 'ask-stale')).toBeUndefined()
  })

  it('is a no-op on a missing store directory', () => {
    expect(pruneAskRecords(askStoreDir(freshDir()), 1000, 100000)).toBe(0)
  })
})

describe('reconcileStaleAsk', () => {
  it('marks a wait left by an earlier process as interrupted', () => {
    const settled = reconcileStaleAsk(makeRecord('ask-stale', { bootId: 'previous-boot' }), 'current-boot')
    expect(settled?.state).toBe('interrupted')
    expect(settled?.note).toContain('重启')
    expect(typeof settled?.settledAt).toBe('number')
  })

  it('leaves a wait owned by this process alone', () => {
    expect(reconcileStaleAsk(makeRecord('ask-live', { bootId: ASK_BOOT_ID }))).toBeUndefined()
  })

  it('does not rewrite a settled record', () => {
    expect(
      reconcileStaleAsk(makeRecord('ask-done', { state: 'done', bootId: 'previous-boot' }), 'current-boot'),
    ).toBeUndefined()
  })

  it('treats a legacy waiting record without a boot id as stale', () => {
    const settled = reconcileStaleAsk(makeRecord('ask-legacy'), 'current-boot')
    expect(settled?.state).toBe('interrupted')
    expect(settled?.note).toContain('更早')
  })
})
