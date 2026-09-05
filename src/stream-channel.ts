import type { ServerResponse } from 'node:http'

export interface StreamChannelDelta {
  advisorId: string
  advisorName?: string
  /** Discussion round this delta belongs to — the client buckets live deltas by (advisorId, round). */
  round?: number
  contentDelta?: string
  thinkingDelta?: string
  done?: boolean
  eventId?: number
  bootId?: string
}

interface BufferedFrame {
  id: number
  payload: string
  ts: number
}

const BOOT_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

const subscribers = new Map<string, Set<ServerResponse>>()
const buffers = new Map<string, BufferedFrame[]>()
const lastIds = new Map<string, number>()

const REPLAY_LIMIT = 500
const BUFFER_TTL_MS = 5 * 60_000

function pruneBuffer(sessionId: string, buffer: BufferedFrame[]): BufferedFrame[] {
  const cutoff = Date.now() - BUFFER_TTL_MS
  const pruned = buffer.filter((frame) => frame.ts >= cutoff)
  if (pruned.length === 0) {
    buffers.delete(sessionId)
    return []
  }
  buffers.set(sessionId, pruned)
  return pruned
}

function writeFrame(res: ServerResponse, frame: BufferedFrame): void {
  try {
    res.write(`id: ${BOOT_ID}:${frame.id}\n${frame.payload}`)
  } catch {
    // Ignore dead connections; cleanup happens on close.
  }
}

function writeResync(res: ServerResponse, reason: 'restart' | 'gap'): void {
  try {
    res.write(`event: resync\ndata: ${JSON.stringify({ reason })}\n\n`)
  } catch {
    // Ignore.
  }
}

export function subscribe(
  sessionId: string,
  res: ServerResponse,
  lastEventId = 0,
  bootId?: string,
): () => void {
  const rawBuffer = buffers.get(sessionId)
  const buffer = rawBuffer ? pruneBuffer(sessionId, rawBuffer) : undefined
  const firstBufferedId = buffer?.[0]?.id

  if (bootId && bootId !== BOOT_ID) {
    // Server restarted: old event ids are meaningless. Ask the client to reset
    // and continue from the live stream (durable session events carry the full
    // content anyway, so nothing is lost).
    writeResync(res, 'restart')
  } else if (lastEventId > 0 && firstBufferedId !== undefined && lastEventId < firstBufferedId - 1) {
    // Replay buffer cannot cover the gap: explicit resync instead of silent loss.
    writeResync(res, 'gap')
  } else if (buffer) {
    for (const frame of buffer) {
      if (frame.id > lastEventId) writeFrame(res, frame)
    }
  }

  let set = subscribers.get(sessionId)
  if (!set) {
    set = new Set()
    subscribers.set(sessionId, set)
  }
  set.add(res)

  const cleanup = () => {
    set?.delete(res)
    if (set?.size === 0) subscribers.delete(sessionId)
  }
  res.on('close', cleanup)
  return cleanup
}

export function publish(sessionId: string, delta: StreamChannelDelta): void {
  const id = (lastIds.get(sessionId) ?? 0) + 1
  lastIds.set(sessionId, id)

  const frame: BufferedFrame = {
    id,
    payload: `data: ${JSON.stringify({ ...delta, eventId: id, bootId: BOOT_ID })}\n\n`,
    ts: Date.now(),
  }

  const rawBuffer = buffers.get(sessionId)
  const buffer = rawBuffer ? pruneBuffer(sessionId, rawBuffer) : []
  buffer.push(frame)
  if (buffer.length > REPLAY_LIMIT) buffer.shift()
  buffers.set(sessionId, buffer)

  const set = subscribers.get(sessionId)
  if (!set || set.size === 0) return
  for (const res of set) {
    writeFrame(res, frame)
  }
}

export function publishDone(sessionId: string, advisorId: string, advisorName?: string): void {
  publish(sessionId, { advisorId, advisorName, done: true })
}

export function closeSession(sessionId: string): void {
  const set = subscribers.get(sessionId)
  if (set) {
    for (const res of set) {
      try {
        res.end()
      } catch {
        // Ignore.
      }
    }
    subscribers.delete(sessionId)
  }
  buffers.delete(sessionId)
  lastIds.delete(sessionId)
}
