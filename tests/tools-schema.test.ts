import { describe, expect, it, vi } from 'vitest'

// The real @deepseek-ai/dsh-tools pulls @deepseek-ai/dsh-sandbox, which is a
// host-provided peer and is not installed in this repo (hence no other test
// imports src/tools.ts). defineTool in the real package returns its options
// wrapped; for schema assertions passing them through unchanged is enough.
vi.mock('@deepseek-ai/dsh-tools', () => ({
  defineTool: (options: unknown) => options,
}))

import { registerAdvisorTools } from '../src/tools'
import type { AdvisorGroupService } from '../src/service'

/** ask_advisors tool schema — the model-visible contract. */
describe('ask_advisors schema', () => {
  const ask = registerAdvisorTools({} as AdvisorGroupService).find((tool) => tool.name === 'ask_advisors')

  it('is registered', () => {
    expect(ask).toBeDefined()
  })

  it('advertises the optional English gist (questionEn) for Jev English judgment', () => {
    const params = ask?.parameters as Record<string, { description?: string }>
    expect(params.questionEn?.description).toContain('English gist')
    expect(params.questionEn?.description).toContain('question')
  })
})
