import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { Config, unwrapVolatileConfig, type Config as ConfigShape } from './config'
import { AdvisorGroupService } from './service'
import { registerAdvisorTools, visibleRosterSessions } from './tools'
import { registerAdvisorSettingsAndRoutes } from './settings-api'
import { archivedSessionIds, cancelDetachedAsks, getSessionController, logJevDecision } from './cross-session'
import { buildAdvisorPrompt } from './prompt'
import { guardAdvisorPrompts, reportPromptGuardFindings } from './prompt-guard'
import { withSessionLogSizes, type RosterSource } from './session-roster'
import { jevConfigured, judgeCrossSessionWithJev } from './providers/jev'
import {
  appendCrossSessionHint,
  crossSessionHintForTurn,
  isGenuineUserPrompt,
  isInjectedContextText,
  rememberCrossSessionHint,
  resetInjectedSkipLog,
  routeSessions,
  shouldConsiderCrossSession,
  shouldLogInjectedSkip,
  userMessageTextOf,
  type JevCrossSessionClient,
  type RouteCandidate,
} from './session-router'
import './events'
import './session-events-host'

export const name = 'dsh-advisor-group'
export const inject = ['tools', 'llm', 'systemPrompt', 'sessions']

export { Config }

/**
 * Recall candidates for the background hint, with workspace-archived sessions
 * dropped: they stay in the raw session list while the sidebar hides them, and
 * a hint must never point at one. An empty archived set changes nothing; a
 * missing registry yields an empty set at the caller ({@link archivedSessionIds}).
 * Pure except for the bounded log-size probe inside the router.
 */
export function recallHintCandidates(input: {
  sessions: readonly RosterSource[]
  archived: ReadonlySet<string>
  text: string
  topN?: number
  currentSessionId: string
  exclude?: readonly string[]
}): RouteCandidate[] {
  const live = input.sessions.filter((session) => !input.archived.has(session.sessionId))
  return routeSessions(withSessionLogSizes(live), input.text, {
    topN: input.topN,
    currentSessionId: input.currentSessionId,
    cache: false,
    exclude: input.exclude ?? [],
  })
}

/**
 * One background cross-session suggestion pass: recall the local candidates
 * for this turn, ask Jev the batched judgment, and remember a one-turn hint.
 * Everything is best effort — no hint, no error, no delivery on any failure.
 */
async function suggestCrossSession(input: {
  ctx: Context
  service: AdvisorGroupService
  jev: NonNullable<ConfigShape['trigger']['jev']>
  sessionId: string
  text: string
  signal: AbortSignal
}): Promise<void> {
  try {
    const controller = getSessionController(input.ctx)
    if (controller === undefined) return
    const config = input.service.getConfig()
    const listed = await controller.list({}, input.signal)
    const roster = visibleRosterSessions(listed.items, config.swarm.rosterIncludeSubagents)
    // Recall stays local (pure); Jev only judges the closed list. Archived
    // sessions are filtered out here so a hint cannot suggest a session the
    // user archived (the sidebar no longer shows it).
    const candidates = recallHintCandidates({
      sessions: roster,
      archived: archivedSessionIds(input.ctx),
      text: input.text,
      topN: config.swarm.routingTopN,
      currentSessionId: input.sessionId,
      exclude: Array.isArray(config.swarm.routingExclude) ? config.swarm.routingExclude : [],
    })
    const judge: JevCrossSessionClient = async (turn) =>
      judgeCrossSessionWithJev(
        turn.text,
        turn.textEn,
        turn.candidates.map((candidate) => ({
          id: candidate.sessionId,
          title: candidate.name,
          // Candidate titles and scopes stay in their original language.
          scope: candidate.reason,
        })),
        input.jev,
        input.signal,
      )
    const hint = await crossSessionHintForTurn({
      text: input.text,
      mode: config.swarm.routingAsk ?? 'gated',
      candidates,
      judge,
      log: logJevDecision,
    })
    if (hint === undefined) return
    rememberCrossSessionHint(input.sessionId, hint)
    console.log(`[dsh-advisor-group] 跨会话提示（仅本轮）：${hint}`)
  } catch {
    // Silent by design: a suggestion must never disturb the turn.
  }
}

export function apply(ctx: Context, config: ConfigShape): void {
  // Config declares volatile fields, so Cordis hands `apply` live references.
  // The service keeps plain values and re-reads them when the loader reports a
  // volatile-only config change.
  const resolvedConfig = unwrapVolatileConfig(config)
  // Load-time prompt guard: heal unambiguous corruption before anything
  // (service, routes, prompt section) reads advisor prompts.
  const guarded = guardAdvisorPrompts(resolvedConfig)
  reportPromptGuardFindings(guarded.findings)
  const service = new AdvisorGroupService(ctx, guarded.config)
  registerAdvisorSettingsAndRoutes(ctx, guarded.config, service)

  for (const tool of registerAdvisorTools(service, ctx)) {
    ctx.tools.register(tool)
  }

  // Inject boundary guidance into the main model's system prompt. The text is
  // evaluated per assembly so settings changes take effect without restart.
  const systemPrompt = (ctx as unknown as {
    systemPrompt: {
      section(section: {
        name: string
        order: number
        text: string | ((context: unknown) => string)
      }): () => void
    }
  }).systemPrompt
  // Detached asks (ask_session with detach: true) hold a background poll loop;
  // stop every one of them when the plugin unloads so a reload cannot leak waits.
  ctx.effect(() => () => cancelDetachedAsks())
  // A background cross-session judgment may hold one in-flight Jev request;
  // abort it when the plugin unloads.
  const hintAborts = new AbortController()
  ctx.effect(() => () => hintAborts.abort())
  // Cross-session suggestion, fired from the same user-message event hook the
  // repeat tracker uses. It only remembers a hint for the NEXT prompt assembly
  // (see appendCrossSessionHint): nothing is delivered and the turn is never
  // blocked. `gated` mode is cheap by design — the pure prefilter decides
  // whether this turn may cost one Jev call; `always` asks on every turn.
  //
  // Only the user's OWN prompt is judged. Every user-role message (typed
  // prompts, injected context, relayed asks) is a `user/message` event, and its
  // producer kind lives on `data.source` — see `isGenuineUserPrompt`. The
  // injected blocks (runtime context, memory snapshot, per-turn time line) were
  // each judged as a user turn on 2026-10-20; the source gate stops that, and
  // `isInjectedContextText` catches a host that mislabels them as `kind: 'user'`.
  // One skipped diagnostics line per turn, never one per injected block.
  ctx.on('session/event', (session: Session, event: { type: string; data?: unknown }) => {
    const text = userMessageTextOf(event)
    if (text === undefined) return
    const cfg = service.getConfig()
    // The plugin's master switch and the swarm switch both silence suggestions.
    if (cfg.enabled === false || cfg.swarm.enabled === false) return
    // `off` writes nothing at all, injected context included (no attempts).
    const mode = cfg.swarm.routingAsk ?? 'gated'
    if (mode === 'off') return
    const injected = isInjectedContextText(text)
    if (!isGenuineUserPrompt(event) || injected) {
      // Injected context and relayed asks are never judged. Only injected
      // context earns a diagnostics line (silent for relays).
      if (injected && shouldLogInjectedSkip(session.id)) {
        logJevDecision({
          kind: 'ask',
          question: text,
          called: false,
          configured: jevConfigured(cfg.trigger.jev),
          decision: 'skipped',
        })
      }
      return
    }
    // A genuine prompt starts a new turn: injected skips may log again.
    resetInjectedSkipLog(session.id)
    const configured = jevConfigured(cfg.trigger.jev)
    if (mode === 'gated' && !shouldConsiderCrossSession(text)) {
      // Cheap stop before any I/O; still recorded so "no hint" is explainable.
      logJevDecision({ kind: 'ask', question: text, called: false, configured, decision: 'skipped' })
      return
    }
    const jev = cfg.trigger.jev
    if (jev === undefined || !configured) {
      logJevDecision({ kind: 'ask', question: text, called: false, configured: false, decision: 'skipped' })
      return
    }
    void suggestCrossSession({
      ctx,
      service,
      jev,
      sessionId: session.id,
      text,
      signal: hintAborts.signal,
    })
  })
  if (systemPrompt) {
    ctx.effect(
      () =>
        systemPrompt.section({
          name: 'advisor-group-boundary',
          order: 150,
          text: (assembly: unknown) => {
            const sessionId = (
              assembly as { agent?: { session?: { id?: string } } } | undefined
            )?.agent?.session?.id
            // The pending cross-session hint is consumed here (one assembly
            // only) and appended to the boundary text.
            return appendCrossSessionHint(
              buildAdvisorPrompt(
                service.getConfig(),
                service.getRepeatPressure(sessionId),
              ),
              sessionId,
            )
          },
        }),
      'dsh-advisor-group: system prompt section',
    )
  }
}
