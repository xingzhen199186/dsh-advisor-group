/**
 * Advisor corps role cards (2026-10-24): one user-curated identity per visible
 * session — a name and a duty. Cards are keyed by session id and stored next to
 * the other plugin fixtures. `ask_session` accepts an exact card name as an
 * additional target spelling; session titles, cwd names and ids stay valid.
 *
 * The store is deliberately dependency-free and synchronous: the file is tiny,
 * written only from the panel, and read before a cross-session ask.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const CORPS_NAME_MAX = 40
export const CORPS_DUTY_MAX = 200
const SESSION_ID_MAX = 200

export interface CorpsCard {
  /** Identity the user talks about, e.g. 「老王」. */
  name: string
  /** What this member is responsible for, e.g. 「架构评审与代码质量」. */
  duty: string
  updatedAt: number
}

export type CorpsCards = Record<string, CorpsCard>

/** Path of the role-card fixture under the DSH home. */
export function corpsFile(): string {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'storages', 'advisor-group', 'corps.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read the card map. A missing, damaged or partially invalid file degrades to
 * the valid cards it still contains (never throws): the panel and the target
 * resolver must keep working.
 */
export function loadCorpsCards(file = corpsFile()): CorpsCards {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
  if (!isRecord(parsed) || !isRecord(parsed.cards)) return {}
  const cards: CorpsCards = {}
  for (const [sessionId, value] of Object.entries(parsed.cards)) {
    if (sessionId.length === 0 || sessionId.length > SESSION_ID_MAX || !isRecord(value)) continue
    const name = typeof value.name === 'string' ? value.name.trim() : ''
    const duty = typeof value.duty === 'string' ? value.duty.trim() : ''
    if (name.length === 0 || name.length > CORPS_NAME_MAX || duty.length > CORPS_DUTY_MAX) continue
    const updatedAt =
      typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
        ? value.updatedAt
        : Date.now()
    cards[sessionId] = { name, duty, updatedAt }
  }
  return cards
}

/** Atomic tmp+rename write; creates the directory when missing. */
export function saveCorpsCards(cards: CorpsCards, file = corpsFile()): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify({ version: 1, cards }, null, 2), 'utf8')
  renameSync(tmp, file)
}

export type CorpsUpsertResult =
  | { ok: true; cards: CorpsCards; card?: CorpsCard }
  | {
      ok: false
      code: 'invalid-session' | 'invalid-name' | 'invalid-duty' | 'duplicate-name'
      error: string
    }

/**
 * Upsert one card. An empty name deletes that session's card (the panel's
 * 「移除」 action). Names are unique case-insensitively across the whole map —
 * `ask_session` resolves a role name to exactly one session, never a guess.
 */
export function upsertCorpsCard(
  cards: CorpsCards,
  sessionId: string,
  rawName: string,
  rawDuty: string,
  now = Date.now(),
): CorpsUpsertResult {
  const id = sessionId.trim()
  if (id.length === 0 || id.length > SESSION_ID_MAX) {
    return { ok: false, code: 'invalid-session', error: '会话 id 不合法。' }
  }
  const name = rawName.trim()
  const duty = rawDuty.trim()
  if (name.length === 0) {
    const next = { ...cards }
    delete next[id]
    return { ok: true, cards: next }
  }
  if (name.length > CORPS_NAME_MAX) {
    return { ok: false, code: 'invalid-name', error: `姓名不能超过 ${CORPS_NAME_MAX} 个字符。` }
  }
  if (duty.length > CORPS_DUTY_MAX) {
    return { ok: false, code: 'invalid-duty', error: `职责不能超过 ${CORPS_DUTY_MAX} 个字符。` }
  }
  const lower = name.toLowerCase()
  for (const [otherId, card] of Object.entries(cards)) {
    if (otherId !== id && card.name.toLowerCase() === lower) {
      return {
        ok: false,
        code: 'duplicate-name',
        error: `姓名「${name}」已经被另一个会话使用，请换一个。`,
      }
    }
  }
  const card: CorpsCard = { name, duty, updatedAt: now }
  return { ok: true, cards: { ...cards, [id]: card }, card }
}

/**
 * Exact, case-insensitive role-name lookup. Duplicate names (only possible in a
 * hand-edited file) resolve to nothing, so a target is never guessed.
 */
export function findCorpsSession(cards: CorpsCards, target: string): string | undefined {
  const wanted = target.trim().toLowerCase()
  if (wanted.length === 0) return undefined
  const hits = Object.entries(cards).filter(([, card]) => card.name.toLowerCase() === wanted)
  return hits.length === 1 ? hits[0][0] : undefined
}

/** Card for one session, when assigned. */
export function corpsCardOf(cards: CorpsCards, sessionId: string): CorpsCard | undefined {
  return cards[sessionId]
}
