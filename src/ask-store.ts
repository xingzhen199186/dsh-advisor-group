/**
 * Durable store for detached (async) asks: `ask_session` will deliver a
 * question now and collect the answer later, possibly in a later turn, so the
 * settled result must survive a turn boundary. One JSON file per ask under
 * `<baseDir>/asks/<askId>.json`; no host services, no timers.
 *
 * Follows the persistence conventions of this repo: plain `node:fs`,
 * atomic tmp+rename writes, and reads that degrade to `undefined` instead of
 * throwing on a missing or damaged file.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** One persisted detached ask. `reply` mirrors the structured answer fields. */
export interface AskRecord {
  askId: string
  /** Asking session id. */
  sessionId: string
  targetSessionId: string
  targetName: string
  question: string
  state: 'waiting' | 'done' | 'timeout' | 'error'
  createdAt: number
  settledAt?: number
  /** ISO time at which the question was delivered. */
  from: string
  /**
   * The inbound cross-session ask this one was made in answer to, when the
   * asking session was itself handling an ask (call-chain trace, not a reply
   * link). Absent for a normal user-initiated ask.
   */
  parentAskId?: string
  answer?: string
  reply?: { conclusion?: string; basis?: string; uncertainty?: string }
  /** Confidence of a settled answer: ok / partial / failed. */
  status?: 'ok' | 'partial' | 'failed'
  note?: string
  error?: string
  /** True once the answer was copied back into the asking session. */
  deliveredBack?: boolean
  /** Why the automatic copy-back did not happen (the record stays readable). */
  deliverBackNote?: string
}

/** askId doubles as a file name, so it must never escape the store directory. */
const ASK_ID_PATTERN = /^[A-Za-z0-9._-]{1,80}$/
const STATES = new Set<AskRecord['state']>(['waiting', 'done', 'timeout', 'error'])

/** The store directory for a base dir such as `$DSH_HOME/storages/advisor-group`. */
export function askStoreDir(baseDir: string): string {
  return `${baseDir}/asks`
}

function assertAskId(askId: string): void {
  if (!ASK_ID_PATTERN.test(askId)) throw new Error('invalid askId')
}

function isAskRecord(value: unknown): value is AskRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<AskRecord>
  return (
    typeof record.askId === 'string' &&
    typeof record.sessionId === 'string' &&
    typeof record.question === 'string' &&
    typeof record.createdAt === 'number' &&
    typeof record.state === 'string' &&
    STATES.has(record.state)
  )
}

function parseRecord(text: string): AskRecord | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  return isAskRecord(value) ? value : undefined
}

/**
 * Write one record atomically: tmp file + rename, so a concurrent reader never
 * sees a half-written JSON document. Creates `dir` when missing.
 */
export function writeAskRecord(dir: string, record: AskRecord): void {
  assertAskId(record.askId)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${record.askId}.json`)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8')
  renameSync(tmp, file)
}

/** Missing or unparsable records read as `undefined`; only a bad id throws. */
export function readAskRecord(dir: string, askId: string): AskRecord | undefined {
  assertAskId(askId)
  try {
    return parseRecord(readFileSync(join(dir, `${askId}.json`), 'utf8'))
  } catch {
    return undefined
  }
}

/** All valid records, newest `createdAt` first, optionally filtered. */
export function listAskRecords(
  dir: string,
  filter?: { sessionId?: string; state?: AskRecord['state'] },
): AskRecord[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const records: AskRecord[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    let text: string
    try {
      text = readFileSync(join(dir, name), 'utf8')
    } catch {
      continue
    }
    const record = parseRecord(text)
    if (record === undefined) continue
    if (filter?.sessionId !== undefined && record.sessionId !== filter.sessionId) continue
    if (filter?.state !== undefined && record.state !== filter.state) continue
    records.push(record)
  }
  records.sort((a, b) => b.createdAt - a.createdAt)
  return records
}

/**
 * Delete settled-or-ageing records (age keyed on `settledAt ?? createdAt`) and
 * stray `.tmp` files left by a crashed writer; returns how many files went.
 * Best-effort by design: a missing directory is 0, per-file failures are skipped.
 */
export function pruneAskRecords(dir: string, olderThanMs: number, now = Date.now()): number {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  const cutoff = now - olderThanMs
  let removed = 0
  for (const name of names) {
    const file = join(dir, name)
    try {
      if (name.endsWith('.tmp')) {
        unlinkSync(file)
        removed += 1
        continue
      }
      if (!name.endsWith('.json')) continue
      const record = parseRecord(readFileSync(file, 'utf8'))
      if (record === undefined) continue
      if ((record.settledAt ?? record.createdAt) < cutoff) {
        unlinkSync(file)
        removed += 1
      }
    } catch {
      // A vanished or locked file must not abort the rest of the prune.
    }
  }
  return removed
}
