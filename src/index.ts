import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { Config, unwrapVolatileConfig, type Config as ConfigShape } from './config'
import { AdvisorGroupService } from './service'
import { registerAdvisorTools, visibleRosterSessions } from './tools'
import { registerAdvisorSettingsAndRoutes } from './settings-api'
import { cancelDetachedAsks, getSessionController } from './cross-session'
import { buildAdvisorPrompt } from './prompt'
import { guardAdvisorPrompts, reportPromptGuardFindings } from './prompt-guard'
import { withSessionLogSizes } from './session-roster'
import { jevConfigured, judgeCrossSessionWithJev } from './providers/jev'
import {
  appendCrossSessionHint,
  crossSessionHintForTurn,
  rememberCrossSessionHint,
  routeSessions,
  shouldConsiderCrossSession,
  type JevCrossSessionClient,
} from './session-router'
import './events'
import './session-events-host'

export const name = 'dsh-advisor-group'
export const inject = ['tools', 'llm', 'systemPrompt', 'sessions']

export { Config }

/** Text of an inbound user-message event, or null when the event is not one. */
function userMessageText(event: { type: string; data?: unknown }): string | null {
  if (event.type !== 'user/message') return null
  const data = event.data as { content?: Array<{ type?: string; text?: string }> } | undefined
  if (!data?.content) return null
  const text = data.content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join(' ')
    .trim()
  return text.length > 0 ? text : null
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
    // Recall stays local (pure); Jev only judges the closed list.
    const candidates = routeSessions(withSessionLogSizes(roster), input.text, {
      topN: config.swarm.routingTopN,
      currentSessionId: input.sessionId,
      cache: false,
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
  ctx.on('session/event', (session: Session, event: { type: string; data?: unknown }) => {
    const text = userMessageText(event)
    if (text === null) return
    const cfg = service.getConfig()
    // The plugin's master switch and the swarm switch both silence suggestions.
    if (cfg.enabled === false || cfg.swarm.enabled === false) return
    const mode = cfg.swarm.routingAsk ?? 'gated'
    if (mode === 'off') return
    if (mode === 'gated' && !shouldConsiderCrossSession(text)) return
    const jev = cfg.trigger.jev
    if (jev === undefined || !jevConfigured(jev)) return
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
