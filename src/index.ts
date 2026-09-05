import type { Context } from '@deepseek-ai/cordis'
import { Config, type Config as ConfigShape } from './config'
import { AdvisorGroupService } from './service'
import { registerAdvisorTools } from './tools'
import { registerAdvisorSettingsAndRoutes } from './settings-api'
import { buildAdvisorPrompt } from './prompt'
import './events'
import './session-events-host'

export const name = 'dsh-advisor-group'
export const inject = ['tools', 'llm', 'systemPrompt', 'sessions']

export { Config }

export function apply(ctx: Context, config: ConfigShape): void {
  const service = new AdvisorGroupService(ctx, config)
  registerAdvisorSettingsAndRoutes(ctx, config, service)

  for (const tool of registerAdvisorTools(service)) {
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
            return buildAdvisorPrompt(
              service.getConfig(),
              service.getRepeatPressure(sessionId),
            )
          },
        }),
      'dsh-advisor-group: system prompt section',
    )
  }
}
