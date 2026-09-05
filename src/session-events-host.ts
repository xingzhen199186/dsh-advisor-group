/**
 * Host-only registration for the advisor-group session event vocabulary.
 *
 * The official 0.1.2-rc.1 compatibility mechanism is the per-event
 * `SessionEvent.ignorable: true` envelope marker: `dsh-session-persistence`
 * refuses unknown event types unless `KNOWN_SESSION_EVENT_TYPES.has(type)`
 * or the stored event is marked ignorable. However `Session.append()` exposes
 * options only for surface events, so a plugin writer currently cannot set
 * `ignorable` on its own log-only events through the public API.
 *
 * This module mutates the runtime `KNOWN_SESSION_EVENT_TYPES` Set so
 * advisor-group events survive restart/resume. This is a pragmatic workaround
 * for the current rc API; if a future DSH version lets plugin appends carry
 * `ignorable` (or adds an official plugin-event registration surface), replace
 * this module instead of mutating shared state.
 */
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'

const ADVISOR_GROUP_EVENT_TYPES = [
  'advisor-group/start',
  'advisor-group/message',
  'advisor-group/delta',
  'advisor-group/end',
  'advisor-group/resume',
] as const

export function ensureAdvisorGroupSessionEventTypes(): void {
  // KNOWN_SESSION_EVENT_TYPES is typed ReadonlySet but the runtime value is a
  // mutable Set in the current rc. This is a workaround: if the Set becomes
  // frozen or the type stops being a Set, fail loud instead of silently
  // producing logs that the persistence layer will refuse to read later.
  const known = KNOWN_SESSION_EVENT_TYPES as unknown
  if (
    !known ||
    typeof known !== 'object' ||
    typeof (known as Set<string>).add !== 'function' ||
    Object.isFrozen(known)
  ) {
    throw new Error(
      'dsh-advisor-group: KNOWN_SESSION_EVENT_TYPES is not mutable. The plugin cannot safely register durable advisor-group events. Please update the plugin when DSH provides an official plugin-event registration API.',
    )
  }

  const set = known as Set<string>
  for (const type of ADVISOR_GROUP_EVENT_TYPES) {
    set.add(type)
  }
}

ensureAdvisorGroupSessionEventTypes()
