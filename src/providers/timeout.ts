/**
 * Combine an optional caller signal with a hard timeout.
 * Node 22+ provides AbortSignal.any and AbortSignal.timeout.
 */
export function withTimeout(ms: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  if (!signal) return timeout
  return AbortSignal.any([signal, timeout])
}

export const ADVISOR_CALL_TIMEOUT_MS = 120_000