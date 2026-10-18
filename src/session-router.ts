/**
 * Question → session router (pure): the keyword retrieval layer behind
 * "ask a question without naming a session". `ask_session` hands an unnamed
 * question to {@link routeSessions}, gets back a small candidate list, and
 * returns it to the caller for the USER to pick — nothing is guessed and
 * nothing is delivered here.
 *
 * Determinism notes:
 * - No model call, no network. The only I/O is the alias-file pair at the
 *   bottom, which the tool layer uses to remember a user's own phrasing.
 * - The one time input is `updatedAt` from the roster, so a test can freeze
 *   time by choosing the rows; the wide-pool decay is measured from the newest
 *   row, never from the wall clock.
 * - Odd input (a null row, a missing title, a NaN timestamp, a corrupt alias
 *   file) degrades to "no match", never to an exception.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { RosterSource } from './session-roster'
import { isNoiseSession, shortSessionName } from './session-roster'

/** One routed session: a choice handed to the user, never an auto-pick. */
export interface RouteCandidate {
  sessionId: string
  name: string
  score: number
  reason: string
}

/** Default and hard caps for how many candidates one pass returns (schema: 1–8). */
const DEFAULT_TOP_N = 3
const MIN_TOP_N = 1
const MAX_TOP_N = 8

/** Shortest run that may act as an exact keyword; also the CJK bigram width. */
const MIN_KEYWORD_LENGTH = 2
/**
 * A bigram-only match needs this many shared bigrams. One shared bigram is
 * almost noise (2–3 character titles would otherwise float to the top on a
 * single accidental pair).
 */
const BIGRAM_MIN_HITS = 2

/**
 * The Dice/bigram contribution is a fuzzy signal: it is capped here so a
 * merely similar title can never outrank a real hit, whatever its length.
 */
const DICE_SCORE_CAP = 40
/**
 * Hard-channel bonuses, added on top of the capped Dice score and clamped at
 * 100. They stay decisive: any one of them lifts the row above the fuzzy cap.
 */
const TITLE_KEYWORD_BONUS = 40
const CWD_KEYWORD_BONUS = 30
const FULL_PHRASE_BONUS = 60
const ALIAS_BONUS = 60
const RUNNING_BONUS = 10

/**
 * A title hit must outrank a plain directory-only hit whatever their Dice
 * similarity: the directory channel's own contribution tops out at
 * DICE_SCORE_CAP + CWD_KEYWORD_BONUS (= 70), so every title hit is lifted above
 * that ceiling. Without this a title's extra token can lower its Dice score and
 * invert the intended priority — the live bug: a titled row at 27 behind
 * cwd-only rows at 28.
 */
const TITLE_HIT_FLOOR = DICE_SCORE_CAP + CWD_KEYWORD_BONUS + 1

/**
 * Shortest run of a session's own name that counts as "the question named this
 * session" when spoken inside the question. Chinese is written without spaces,
 * so a project name is normally embedded in a longer run ("那个做极简遥控器的
 * 会话"); a run this long is specific enough to be a hard channel, while a
 * shorter one stays fuzzy (3 characters are routinely a coincidence).
 */
const TITLE_MENTION_MIN_CHARS = 4
/**
 * The same, for one working-directory segment. A folder name is a project
 * identifier rather than prose, so one character less already carries weight.
 */
const CWD_MENTION_MIN_CHARS = 3

/** Zero-hit fallback pool: fuzzy top 20 ∪ most recent 10, deduped. */
const WIDE_FUZZY_LIMIT = 20
const WIDE_RECENT_LIMIT = 10
/** Half-life of the fallback time decay, measured from the newest row. */
const DECAY_HALF_LIFE_MS = 86_400_000

const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u
const TOKEN_RUN = /[\p{L}\p{N}]+/gu
const RUN_SEGMENT = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+|[A-Za-z0-9]+/gu
const PATH_SPLIT = /[\\/]+/u
const DRIVE_SEGMENT = /^[A-Za-z]:$/u
/** Whitespace, punctuation and symbols carry no routing signal. */
const NOISE = /[\s\p{P}\p{S}]+/gu

/** The token set one text contributes: words, CJK bigrams, and whole runs. */
interface TokenSet {
  /** Lowercased ASCII/number words. */
  words: Set<string>
  /** Two-character CJK bigrams. */
  bigrams: Set<string>
  /** Whole runs of 2+ characters: the exact-substring channel. */
  phrases: Set<string>
}

/** One indexed roster row: its display facts plus the token set built from them. */
interface IndexedSession {
  sessionId: string
  name: string
  /** Working directory, used to shorten a fallback display name. */
  cwd?: string
  /** Normalised title, for exact-keyword and whole-phrase substrings. */
  titleText: string
  /** True when the row carries a real title; false means a folder fallback name. */
  hasTitle: boolean
  /** Normalised cwd path segments (never the drive letter). */
  cwdTexts: string[]
  tokens: TokenSet
  running: boolean
  updatedAt: number
}

/** The question side: its token set plus the exact-substring channels. */
interface QuestionQuery {
  tokens: TokenSet
  /** Normalised keywords, longest first, so the most specific one names the reason. */
  keywords: string[]
  /** Normalised whole question. */
  phrase: string
}

/** One scored row, carrying the order keys alongside the user-facing fields. */
interface ScoredRow {
  row: IndexedSession
  score: number
  reason: string
  /** True when the title itself carried the match; equal scores keep title hits first. */
  titleHit: boolean
}

function emptyTokens(): TokenSet {
  return { words: new Set(), bigrams: new Set(), phrases: new Set() }
}

/** The host publishes the title as a plain string; the `{ title }` wrapper is tolerated. */
function titleOf(projections: unknown): string {
  if (projections === null || typeof projections !== 'object') return ''
  const values = (projections as { readonly values?: unknown }).values
  if (values === null || typeof values !== 'object') return ''
  const raw = (values as { readonly title?: unknown }).title
  const text =
    typeof raw === 'string'
      ? raw
      : raw !== null && typeof raw === 'object' && typeof (raw as { readonly title?: unknown }).title === 'string'
        ? (raw as { readonly title: string }).title
        : ''
  return text.trim()
}

/**
 * Lowercase, then strip whitespace/punctuation/symbols. This is the key form
 * used for exact keywords, whole-phrase containment and alias entries, so a
 * user's phrasing survives their own spacing and punctuation.
 * @param text - any string; a non-string reads as ''.
 * @returns the normalised key (possibly empty).
 */
export function normalizeAliasKey(text: string): string {
  if (typeof text !== 'string') return ''
  return text.toLowerCase().replace(NOISE, '')
}

/**
 * Add one text's tokens to a token set.
 *
 * CJK runs are additionally cut into 2-character bigrams; ASCII runs stay whole
 * words. A CJK run that is a single character is skipped — too weak to carry a
 * routing decision on its own.
 */
function addText(target: TokenSet, text: string): void {
  if (typeof text !== 'string' || text.length === 0) return
  for (const run of text.match(TOKEN_RUN) ?? []) {
    if (!CJK_CHAR.test(run)) {
      const word = run.toLowerCase()
      target.words.add(word)
      if (word.length >= MIN_KEYWORD_LENGTH) target.phrases.add(word)
      continue
    }
    for (const segment of run.match(RUN_SEGMENT) ?? []) {
      if (!CJK_CHAR.test(segment)) {
        const word = segment.toLowerCase()
        target.words.add(word)
        if (word.length >= MIN_KEYWORD_LENGTH) target.phrases.add(word)
        continue
      }
      if (segment.length < MIN_KEYWORD_LENGTH) continue
      target.phrases.add(segment)
      for (let i = 0; i + MIN_KEYWORD_LENGTH <= segment.length; i += 1) {
        target.bigrams.add(segment.slice(i, i + MIN_KEYWORD_LENGTH))
      }
    }
  }
}

/** Index one roster row; a row without a sessionId cannot be routed and is skipped. */
function indexSession(session: unknown): IndexedSession | undefined {
  if (session === null || typeof session !== 'object') return undefined
  const raw = session as Record<string, unknown>
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : ''
  if (sessionId.length === 0) return undefined
  const title = titleOf(raw.projections)
  const cwd = typeof raw.cwd === 'string' ? raw.cwd : ''
  const cwdSegments = cwd.split(PATH_SPLIT).filter((segment) => segment.length > 0 && !DRIVE_SEGMENT.test(segment))
  const tokens = emptyTokens()
  const cwdTexts: string[] = []
  if (title.length > 0) addText(tokens, title)
  for (const segment of cwdSegments) {
    addText(tokens, segment)
    cwdTexts.push(normalizeAliasKey(segment))
  }
  // Without a title the candidate is named after the project folder, never the
  // whole path (the roster renderer shows that path once, in the hint).
  const folderName = cwdSegments.length > 0 ? cwdSegments[cwdSegments.length - 1] : ''
  return {
    sessionId,
    name: title.length > 0 ? title : folderName.length > 0 ? folderName : cwd.length > 0 ? cwd : sessionId,
    ...(cwd.length > 0 ? { cwd } : {}),
    titleText: normalizeAliasKey(title),
    hasTitle: title.length > 0,
    cwdTexts,
    tokens,
    running: raw.running === true,
    updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
  }
}

/** Read the question once: tokens, longest-first keywords, and the whole phrase. */
function readQuestion(question: unknown): QuestionQuery {
  const text = typeof question === 'string' ? question : ''
  const tokens = emptyTokens()
  addText(tokens, text)
  const keywords = [...tokens.phrases]
    .map((phrase) => normalizeAliasKey(phrase))
    .filter((phrase) => phrase.length >= MIN_KEYWORD_LENGTH)
    .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))
  return { tokens, keywords, phrase: normalizeAliasKey(text) }
}

/** Shared token count, iterating the smaller set. */
function intersectionSize(a: Set<string>, b: Set<string>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let hits = 0
  for (const token of small) if (large.has(token)) hits += 1
  return hits
}

/** Dice coefficient over the two token sets: 2|A∩B|/(|A|+|B|). */
function diceScore(question: TokenSet, session: TokenSet): number {
  const total = question.words.size + question.bigrams.size + session.words.size + session.bigrams.size
  if (total === 0) return 0
  const shared =
    intersectionSize(question.words, session.words) + intersectionSize(question.bigrams, session.bigrams)
  return (2 * shared) / total
}

/** Longest keyword found as an exact substring of any haystack, or undefined. */
function keywordHit(keywords: readonly string[], haystacks: readonly string[]): string | undefined {
  for (const keyword of keywords) {
    for (const haystack of haystacks) {
      if (haystack.length > 0 && haystack.includes(keyword)) return keyword
    }
  }
  return undefined
}

/**
 * Longest run of `text` that also occurs inside `phrase`, provided it is at
 * least `minChars` long; undefined otherwise.
 *
 * This is the reverse direction of {@link keywordHit}: it asks whether a
 * session's own name was spoken inside the question. Chinese has no spaces, so
 * "那个做极简遥控器的会话" never yields a keyword, yet it clearly names 极简遥控器.
 * Anchoring on a minimum length keeps a short accidental overlap fuzzy.
 */
function mentionIn(text: string, phrase: string, minChars: number): string | undefined {
  if (text.length < minChars || phrase.length === 0) return undefined
  let best = ''
  for (let start = 0; start + minChars <= text.length; start += 1) {
    const seed = text.slice(start, start + minChars)
    for (let at = phrase.indexOf(seed); at >= 0; at = phrase.indexOf(seed, at + 1)) {
      let length = minChars
      while (
        start + length < text.length &&
        at + length < phrase.length &&
        text[start + length] === phrase[at + length]
      ) {
        length += 1
      }
      if (length > best.length) best = text.slice(start, start + length)
    }
  }
  return best.length > 0 ? best : undefined
}

/** The longest mention across several haystacks, or undefined. */
function mentionInAny(texts: readonly string[], phrase: string, minChars: number): string | undefined {
  let best: string | undefined
  for (const text of texts) {
    const hit = mentionIn(text, phrase, minChars)
    if (hit !== undefined && (best === undefined || hit.length > best.length)) best = hit
  }
  return best
}

/** Score one indexed row, or return undefined when it is neither matched nor hard-channel. */
function scoreRow(row: IndexedSession, query: QuestionQuery, aliasHit: string | undefined): ScoredRow | undefined {
  const wordHits = intersectionSize(query.tokens.words, row.tokens.words)
  const bigramHits = intersectionSize(query.tokens.bigrams, row.tokens.bigrams)
  // Bigram-only matches need two shared bigrams; a word hit counts on its own.
  const matched = wordHits > 0 || bigramHits >= BIGRAM_MIN_HITS
  // The title channel fires in both directions: a whole question run inside the
  // title, or the title's own name spoken inside the question. The second is
  // what a plain Chinese sentence hits; the first still names the keyword.
  const titleKeyword = keywordHit(query.keywords, [row.titleText])
  const titleHit = titleKeyword ?? mentionIn(row.titleText, query.phrase, TITLE_MENTION_MIN_CHARS)
  // The directory channel mirrors it, and only when the title did not already win.
  const cwdKeyword = titleHit === undefined ? keywordHit(query.keywords, row.cwdTexts) : undefined
  const cwdHit =
    titleHit !== undefined
      ? undefined
      : (cwdKeyword ?? mentionInAny(row.cwdTexts, query.phrase, CWD_MENTION_MIN_CHARS))
  const fullPhrase =
    query.phrase.length >= MIN_KEYWORD_LENGTH &&
    (row.titleText.includes(query.phrase) || row.cwdTexts.some((text) => text.includes(query.phrase)))
  // Fuzzy base first, capped so similarity alone stays below every hard channel.
  let score = matched ? Math.min(DICE_SCORE_CAP, Math.round(diceScore(query.tokens, row.tokens) * 100)) : 0
  if (titleHit !== undefined) score += TITLE_KEYWORD_BONUS
  else if (cwdHit !== undefined) score += CWD_KEYWORD_BONUS
  if (fullPhrase) score += FULL_PHRASE_BONUS
  if (aliasHit !== undefined) score += ALIAS_BONUS
  if (row.running) score += RUNNING_BONUS
  score = Math.min(100, Math.max(0, score))
  if (titleHit !== undefined) score = Math.max(score, TITLE_HIT_FLOOR)
  const hard = titleHit !== undefined || cwdHit !== undefined || fullPhrase || aliasHit !== undefined || row.running
  if (!matched && !hard) return undefined
  const reason =
    aliasHit !== undefined
      ? '别名命中'
      : titleHit !== undefined
        ? `标题命中「${titleHit}」`
        : cwdHit !== undefined
          ? '目录命中'
          : fullPhrase
            ? '整句命中'
            : matched
              ? '问题相关'
              : '运行中'
  return { row, score, reason, titleHit: titleHit !== undefined }
}

/** Deterministic order: score desc, a title hit above a directory-only hit, running first, then recency, then shorter title. */
function compareScored(a: ScoredRow, b: ScoredRow): number {
  if (a.score !== b.score) return b.score - a.score
  // Equal scores must never rank a directory-only match above a title match.
  if (a.titleHit !== b.titleHit) return a.titleHit ? -1 : 1
  if (a.row.running !== b.row.running) return a.row.running ? -1 : 1
  if (a.row.updatedAt !== b.row.updatedAt) return b.row.updatedAt - a.row.updatedAt
  if (a.row.name.length !== b.row.name.length) return a.row.name.length - b.row.name.length
  return a.row.sessionId < b.row.sessionId ? -1 : a.row.sessionId > b.row.sessionId ? 1 : 0
}

/** Default 3; a non-finite value falls back to it, everything else is clamped to 1..8. */
function clampTopN(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TOP_N
  return Math.min(MAX_TOP_N, Math.max(MIN_TOP_N, Math.floor(value)))
}

/** Normalised alias phrasing → sessionId; malformed entries are dropped. */
function readAliasMap(aliases: unknown): Map<string, string> {
  const map = new Map<string, string>()
  if (aliases === null || typeof aliases !== 'object' || Array.isArray(aliases)) return map
  for (const [phrasing, sessionId] of Object.entries(aliases as Record<string, unknown>)) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) continue
    const key = normalizeAliasKey(phrasing)
    if (key.length === 0) continue
    map.set(key, sessionId)
  }
  return map
}

/** Sessions whose phrasing occurs inside the question; the longest phrasing per session wins. */
function aliasHits(questionPhrase: string, aliases: Map<string, string>): Map<string, string> {
  const hits = new Map<string, string>()
  if (questionPhrase.length === 0) return hits
  for (const [phrasing, sessionId] of aliases) {
    if (!questionPhrase.includes(phrasing)) continue
    const current = hits.get(sessionId)
    if (current === undefined || phrasing.length > current.length) hits.set(sessionId, phrasing)
  }
  return hits
}

function candidateOf(scored: ScoredRow): RouteCandidate {
  return {
    sessionId: scored.row.sessionId,
    name: shortSessionName(scored.row.name, scored.row.cwd),
    score: scored.score,
    reason: scored.reason,
  }
}

/**
 * Take the best `topN` rows, in order, without spending two slots on one
 * fallback name: several untitled sessions in the same folder all render as
 * "极简遥控器", and letting them fill the list hides the titled match behind
 * identical labels. A titled row is never skipped or displaced by that rule —
 * only a title-less row whose label an earlier title-less row already used.
 */
function selectTop(scored: readonly ScoredRow[], topN: number): RouteCandidate[] {
  const usedFallbackNames = new Set<string>()
  const picked: ScoredRow[] = []
  for (const row of scored) {
    if (!row.row.hasTitle) {
      const label = shortSessionName(row.row.name, row.row.cwd)
      if (usedFallbackNames.has(label)) continue
      usedFallbackNames.add(label)
    }
    picked.push(row)
    if (picked.length >= topN) break
  }
  return picked.map(candidateOf)
}

/**
 * Zero-hit fallback: fuzzy top 20 ∪ most recent 10, deduped, then scored by the
 * same Dice formula under a time decay. The decay is measured from the newest
 * row in the pool, so the result depends only on the roster, not on the clock.
 */
function widePool(indexed: readonly IndexedSession[], query: QuestionQuery, topN: number): RouteCandidate[] {
  const newest = indexed.reduce((max, row) => (row.updatedAt > max ? row.updatedAt : max), 0)
  const pool = new Map<string, IndexedSession>()
  const byDice = [...indexed].sort(
    (a, b) => diceScore(query.tokens, b.tokens) - diceScore(query.tokens, a.tokens),
  )
  for (const row of byDice.slice(0, WIDE_FUZZY_LIMIT)) pool.set(row.sessionId, row)
  const byRecency = [...indexed].sort((a, b) => b.updatedAt - a.updatedAt)
  for (const row of byRecency.slice(0, WIDE_RECENT_LIMIT)) pool.set(row.sessionId, row)
  const scored: ScoredRow[] = [...pool.values()].map((row) => {
    const base = Math.min(DICE_SCORE_CAP, Math.round(diceScore(query.tokens, row.tokens) * 100))
    const age = newest - row.updatedAt
    const decay = age > 0 ? Math.pow(0.5, age / DECAY_HALF_LIFE_MS) : 1
    return {
      row,
      score: Math.min(100, Math.max(0, Math.round(base * decay))),
      reason: base > 0 ? '弱匹配' : '最近活跃',
      titleHit: false,
    }
  })
  scored.sort(compareScored)
  return selectTop(scored, topN)
}

/**
 * Score every roster session against a question and return the candidates.
 *
 * Hard channels always join the candidate set regardless of score (unless the
 * topN cap pushes them out): a title (or directory) name spoken inside the
 * question, a whole question keyword inside the title, a known alias phrasing,
 * and "the session is running". Everything else must clear the bigram
 * threshold. When nothing matches, the wide pool answers with the most
 * relevant/recent sessions instead of an empty list.
 *
 * @param sessions - rows from `sessionController.list()`; malformed rows are skipped.
 * @param question - the question as the caller wrote it; no target name needed.
 * @param options.topN - max candidates, default 3, clamped to 1..8.
 * @param options.aliases - normalised user phrasing → sessionId; the caller
 *   drops entries whose session is no longer in the roster.
 * @param options.currentSessionId - the asking session, filtered out so the
 *   model is never offered the session it is already in.
 * @returns candidates ordered best-first; never throws, never delivers.
 */
export function routeSessions(
  sessions: readonly RosterSource[],
  question: string,
  options?: { topN?: number; aliases?: Readonly<Record<string, string>>; currentSessionId?: string },
): RouteCandidate[] {
  const topN = clampTopN(options?.topN)
  const query = readQuestion(question)
  const hitsBySession = aliasHits(query.phrase, readAliasMap(options?.aliases))
  const indexed: IndexedSession[] = []
  for (const session of Array.isArray(sessions) ? (sessions as readonly unknown[]) : []) {
    if (isNoiseSession(session, options?.currentSessionId)) continue
    const row = indexSession(session)
    if (row !== undefined) indexed.push(row)
  }
  if (indexed.length === 0) return []
  const scored: ScoredRow[] = []
  for (const row of indexed) {
    const hit = scoreRow(row, query, hitsBySession.get(row.sessionId))
    if (hit !== undefined) scored.push(hit)
  }
  if (scored.length > 0) {
    scored.sort(compareScored)
    return selectTop(scored, topN)
  }
  return widePool(indexed, query, topN)
}

/**
 * Read the alias file: normalised phrasing → sessionId.
 * A missing, unreadable or corrupt file reads as {}, and no call ever throws.
 * @param file - absolute path of the JSON alias file.
 * @returns the usable alias map.
 */
export function loadAliases(file: string): Record<string, string> {
  if (typeof file !== 'string' || file.length === 0) return {}
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return {}
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return {}
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const aliases: Record<string, string> = {}
  for (const [phrasing, sessionId] of Object.entries(value as Record<string, unknown>)) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) continue
    const key = normalizeAliasKey(phrasing)
    if (key.length === 0) continue
    aliases[key] = sessionId
  }
  return aliases
}

/**
 * Remember one user phrasing for a session, atomically (tmp + rename).
 * Never throws: a failed write only means the phrasing was not remembered.
 * @param file - absolute path of the JSON alias file.
 * @param phrasing - the user's own words for the session.
 * @param sessionId - the session that phrasing means.
 */
export function saveAlias(file: string, phrasing: string, sessionId: string): void {
  const key = normalizeAliasKey(phrasing)
  if (key.length === 0 || typeof sessionId !== 'string' || sessionId.length === 0) return
  try {
    const aliases = loadAliases(file)
    aliases[key] = sessionId
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(aliases, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch (error) {
    console.warn('[dsh-advisor-group] 会话别名写入失败（本次不记忆该说法）：', error)
  }
}
