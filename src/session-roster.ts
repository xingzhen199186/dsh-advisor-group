/**
 * Session roster (pure): turn `sessionController.list()` rows into a compact,
 * model-readable list. No host services and no I/O here.
 *
 * The title projection is published by the host (`dsh-session-title`) as a
 * **plain string**; a `{ title }` wrapper is accepted for older cached rows.
 * Every miss degrades to the same cwd+time fallback `cross-session.ts` uses,
 * and no malformed row may throw.
 */

/** The minimal session shape this module reads (structurally compatible with the host row). */
export interface RosterSource {
  sessionId: string
  updatedAt: number
  running: boolean
  cwd?: string
  origin?: 'subagent'
  /** The host marks a freshly created, never-used session as blank. */
  blank?: boolean
  projections?: { values?: { title?: unknown } }
}

/** One rendered roster entry: display name, recency hint, and the host facts it came from. */
export interface RosterRow {
  sessionId: string
  name: string
  cwd?: string
  updatedAt: number
  running: boolean
  subagent: boolean
  hint: string
  /** True when the host published a real title; false means the row uses the fallback name. */
  hasTitle: boolean
}

const UNKNOWN_CWD = '（未知工作目录）'
const UNKNOWN_TIME = '（未知时间）'
const DEFAULT_LIMIT = 30
const MIN_LIMIT = 1
const MAX_LIMIT = 50
/** Hard cap for one hint line, keeping each roster entry readable. */
const HINT_MAX = 40
/** Separator the fallback label puts between the working directory and the ISO time. */
const FALLBACK_SEPARATOR = ' · '
/** ISO-8601 UTC stamp, the time half of the fallback label. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u
const PATH_SPLIT = /[\\/]+/u
const DRIVE_SEGMENT = /^[A-Za-z]:$/u

/**
 * The exclusion list for roster/routing candidates: titles that carry no
 * meaning. `生成会话标题` is the leftover of the title-generation session,
 * and a bare greeting is an empty chat that never named itself.
 */
export const NOISE_TITLE_PATTERN = /生成会话标题|^你好[，,\s]*$/u

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

/**
 * Read the title projection: the host plain string first, then the legacy
 * `{ title }` wrapper. Returns '' when neither yields a non-empty string.
 */
function titleOf(projections: unknown): string {
  if (!isRecord(projections)) return ''
  const values = projections.values
  if (!isRecord(values)) return ''
  const raw = values.title
  const text =
    typeof raw === 'string'
      ? raw
      : isRecord(raw) && typeof raw.title === 'string'
        ? raw.title
        : ''
  return text.trim()
}

/**
 * Whether a raw roster row must stay out of the roster and the routing pool:
 * a blank session, a title-generation leftover, or the asking session itself.
 * Malformed input reads as "keep" here — the caller's own parser degrades it.
 * @param session - any raw row.
 * @param currentSessionId - the asking session, dropped when its id matches.
 */
export function isNoiseSession(session: unknown, currentSessionId?: string): boolean {
  if (!isRecord(session)) return false
  if (session.blank === true) return true
  const title = titleOf(session.projections)
  if (title.length > 0 && NOISE_TITLE_PATTERN.test(title)) return true
  return (
    typeof currentSessionId === 'string' &&
    currentSessionId.length > 0 &&
    session.sessionId === currentSessionId
  )
}

/** Last non-empty segment of a path, for the human-readable fallback name. */
function lastPathSegment(path: string): string {
  const parts = path.split(PATH_SPLIT).filter((part) => part.length > 0)
  return parts.length === 0 ? '' : parts[parts.length - 1]
}

/**
 * Turn the fallback display name (`<path> · <ISO time>`) into something a
 * person can read: the last path segment. A real title is returned unchanged,
 * so this is safe to call at every render site.
 *
 * The last segment is used as-is; when it carries no name of its own (a bare
 * drive such as `I:`) the label adds ` · 未命名`.
 * @param name - the row name as the host/renderer produced it.
 * @param cwd - the row's working directory, used to confirm the fallback shape.
 * @returns a short display name, or `name` unchanged.
 */
export function shortSessionName(name: string, cwd?: string): string {
  if (typeof name !== 'string' || name.length === 0) return name
  const at = name.lastIndexOf(FALLBACK_SEPARATOR)
  if (at < 0) return name
  const where = name.slice(0, at)
  const when = name.slice(at + FALLBACK_SEPARATOR.length)
  if (!ISO_TIME.test(when)) return name
  const pathLike =
    cwd !== undefined && cwd.length > 0
      ? where === cwd
      : /^[A-Za-z]:[\\/]/u.test(where) || where.startsWith('\\\\')
  if (!pathLike) return name
  const segment = lastPathSegment(where)
  if (segment.length === 0) return '未命名'
  if (DRIVE_SEGMENT.test(segment)) return `${segment} · 未命名`
  return segment
}

/**
 * Deterministic fallback label, identical to `fallbackSessionName` in
 * `cross-session.ts`: working directory plus the ISO time, or only the
 * directory when the time is unknown.
 */
function fallbackName(cwd: string | undefined, updatedAt: unknown): string {
  const where = cwd === undefined ? UNKNOWN_CWD : cwd
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return where
  const at = new Date(updatedAt)
  const stamp = Number.isNaN(at.getTime()) ? String(updatedAt) : at.toISOString()
  return `${where} · ${stamp}`
}

/** Relative recency in Chinese: 刚刚 / N 分钟前 / N 小时前 / N 天前. */
function relativeTime(updatedAt: number): string {
  const diff = Date.now() - updatedAt
  if (!Number.isFinite(diff)) return UNKNOWN_TIME
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

/** Directory plus recency, truncated so the whole hint stays within {@link HINT_MAX}. */
function buildHint(cwd: string | undefined, updatedAt: number | undefined): string {
  const where = cwd === undefined ? UNKNOWN_CWD : cwd
  const when = updatedAt === undefined ? UNKNOWN_TIME : relativeTime(updatedAt)
  const suffix = ` · ${when}`
  const room = HINT_MAX - suffix.length
  const dir = where.length <= room ? where : `${where.slice(0, Math.max(0, room - 1))}…`
  return `${dir}${suffix}`
}

/** Default 30, hard-clamped to 1..50; a malformed limit falls back to the default. */
function clampLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.floor(value)))
}

/** Running sessions first, then most recently updated first. */
function compareRows(a: RosterRow, b: RosterRow): number {
  if (a.running !== b.running) return a.running ? -1 : 1
  if (a.updatedAt === b.updatedAt) return 0
  return a.updatedAt > b.updatedAt ? -1 : 1
}

function matchesQuery(row: RosterRow, query: string): boolean {
  return (
    row.name.toLowerCase().includes(query) ||
    (row.cwd !== undefined && row.cwd.toLowerCase().includes(query)) ||
    row.hint.toLowerCase().includes(query)
  )
}

/**
 * Build the roster: drop unusable rows, filter (optional), order, then cap.
 * @param sessions - rows from `sessionController.list()`; malformed rows are degraded, never fatal.
 * @param options.query - case-insensitive substring over name, cwd, or hint; empty means no filter.
 * @param options.limit - max rows, default 30, clamped to 1..50.
 * @param options.hideSubagents - also drop subagent rows (the setting's default).
 * @returns ordered rows with display names, flags, and recency hints.
 */
export function buildSessionRoster(
  sessions: readonly RosterSource[],
  options?: { query?: string; limit?: number; hideSubagents?: boolean },
): RosterRow[] {
  const query = typeof options?.query === 'string' ? options.query.trim().toLowerCase() : ''
  const rows: RosterRow[] = []
  for (const session of sessions) {
    if (!isRecord(session)) continue
    if (isNoiseSession(session)) continue
    const raw = session as unknown as Record<string, unknown>
    if (options?.hideSubagents === true && raw.origin === 'subagent') continue
    const cwd = typeof raw.cwd === 'string' && raw.cwd.length > 0 ? raw.cwd : undefined
    const hasTime = typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)
    const title = titleOf(raw.projections)
    const row: RosterRow = {
      sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
      name: title || fallbackName(cwd, raw.updatedAt),
      ...(cwd === undefined ? {} : { cwd }),
      updatedAt: hasTime ? (raw.updatedAt as number) : 0,
      running: raw.running === true,
      subagent: raw.origin === 'subagent',
      hint: buildHint(cwd, hasTime ? (raw.updatedAt as number) : undefined),
      hasTitle: title.length > 0,
    }
    if (query.length > 0 && !matchesQuery(row, query)) continue
    rows.push(row)
  }
  rows.sort(compareRows)
  return rows.slice(0, clampLimit(options?.limit))
}

/**
 * Render the roster as the text the model reads. `hasTitle` stays out of the
 * text on purpose: it is a diagnostic fact, not a hint for the model.
 * @param rows - ordered rows from {@link buildSessionRoster}.
 * @param options.filtered - true when a query produced these rows, so the head reads 匹配.
 * @returns heading plus one `- <name> — <hint>` line per row, or the empty notice.
 */
export function renderRoster(rows: readonly RosterRow[], options?: { filtered?: boolean }): string {
  if (rows.length === 0) return '没有匹配的会话。'
  const head = `${options?.filtered === true ? '匹配' : '共'} ${rows.length} 个会话`
  const lines = rows.map((row) => {
    const flags = `${row.running ? ' · 运行中' : ''}${row.subagent ? ' · 子代理' : ''}`
    return `- ${shortSessionName(row.name, row.cwd)} — ${row.hint}${flags}`
  })
  return [head, ...lines].join('\n')
}
