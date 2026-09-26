import { describe, expect, it } from 'vitest'
import { Config, unwrapVolatileConfig } from '../src/config'

/**
 * DSH 0.1.7-rc.2 reads and persists plugin config through dsh-settings, which
 * only exposes fields the schema marks volatile. Without those markers
 * describe() drops the plugin entry entirely and every update/replace() call
 * fails with `Plugin entry "..." has no volatile fields` — that is exactly why
 * the settings page could not save after the 0.1.7 adaptation.
 */
describe('0.1.7-rc.2 settings persistence contract', () => {
  const volatileFields = ['enabled', 'discussion', 'trigger', 'ui', 'quota', 'advisors']

  it('marks every settings-page field volatile so dsh-settings accepts writes', () => {
    const dict = (Config as unknown as {
      dict: Record<string, { meta: Record<string, unknown> } | undefined>
    }).dict

    for (const field of volatileFields) {
      expect(dict[field]?.meta?.volatile, `${field} must declare .volatile()`).toBe(true)
    }
  })

  it('leaves volatile references behind that unwrapVolatileConfig resolves', () => {
    const liveRef = { get: () => ({ maxRounds: 3 }) }

    expect(unwrapVolatileConfig({ discussion: liveRef })).toEqual({ discussion: { maxRounds: 3 } })
  })
})
