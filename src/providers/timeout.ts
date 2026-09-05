/**
 * Combine an optional caller signal with a hard timeout.
 * Node 22+ provides AbortSignal.any and AbortSignal.timeout.
 */
export function withTimeout(ms: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  if (!signal) return timeout
  return AbortSignal.any([signal, timeout])
}

/**
 * Same combination, but keeps the timeout signal reachable so the caller can
 * classify an aborted stream: timeout fired -> graceful truncation (keep the
 * partial thinking, mark `truncated`); caller signal fired -> cancellation.
 */
export function timeoutSignalPair(ms: number, signal?: AbortSignal): {
  signal: AbortSignal
  isTimeout: () => boolean
} {
  const timeout = AbortSignal.timeout(ms)
  return {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    isTimeout: () => timeout.aborted,
  }
}

export const ADVISOR_CALL_TIMEOUT_MS = 120_000