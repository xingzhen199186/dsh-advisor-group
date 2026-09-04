import type { AdvisorConfig, Config } from './config'

/**
 * Advisors whose model is empty or whitespace-only.
 *
 * The ask_advisors tool refuses to start a consultation while any advisor is
 * missing a model (fast fail with a precise reason instead of a mid-round
 * failure); the settings card marks the field red in the same condition.
 */
export function advisorsMissingModel(config: Pick<Config, 'advisors'> | AdvisorConfig[]): AdvisorConfig[] {
  const advisors = Array.isArray(config) ? config : config.advisors
  return advisors.filter((advisor) => !advisor.model || !advisor.model.trim())
}
