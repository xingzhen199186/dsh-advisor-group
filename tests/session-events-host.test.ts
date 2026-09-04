import { describe, expect, it } from 'vitest'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { ensureAdvisorGroupSessionEventTypes } from '../src/session-events-host'

describe('advisor-group session event registration', () => {
  it('registers the four log-only event types into KNOWN_SESSION_EVENT_TYPES (fails loud when the Set stops being mutable)', () => {
    expect(() => ensureAdvisorGroupSessionEventTypes()).not.toThrow()
    for (const type of [
      'advisor-group/start',
      'advisor-group/message',
      'advisor-group/delta',
      'advisor-group/end',
    ]) {
      expect(KNOWN_SESSION_EVENT_TYPES.has(type)).toBe(true)
    }
  })
})
